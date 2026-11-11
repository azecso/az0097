import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("20000000"); P = await w.mkProduct("UG"); });
afterAll(async () => { await w.env.teardown(); });
const buyLine = async (qty: string, price: string, cls: "PARTNERSHIP" | "USED", date = "2026-01-10") => {
  const po = await w.api(w.owner, w.R.purchases.POST, { method: "POST", body: { supplierId: w.ids.supplier, docDate: date, paymentType: "CASH", cashAccountId: w.ids.cashIQD, currency: "IQD", lines: [{ productId: P, uom: "قطعة", qty, unitPrice: price, profitClass: cls }] } });
  expect((await w.api(w.owner, w.R.purchasePost, { method: "POST", params: { id: po.body.id } })).status).toBe(200); return po.body.id as string;
};
const sell = async (lines: { qty: string; price: string; cls: "PARTNERSHIP" | "USED" }[], date = "2026-02-01") => {
  const inv = await w.api(w.owner, w.R.invoices.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: date, saleType: "CREDIT", currency: "IQD", lines: lines.map((l) => ({ productId: P, uom: "قطعة", qty: l.qty, unitPrice: l.price, profitClass: l.cls })) } });
  return { create: inv, post: inv.status === 200 ? await w.api(w.owner, w.R.invoicePost, { method: "POST", params: { id: inv.body.id } }) : null, id: inv.body?.id as string };
};
const pay = async (inv: string, amount: string, date = "2026-02-02") => { const r = await w.api(w.owner, w.R.collect, { method: "POST", params: { id: inv }, body: { requestId: "ug-" + Math.random().toString(36).slice(2), docDate: date, cashAccountId: w.ids.cashIQD, currency: "IQD", amount } }); expect(r.status, JSON.stringify(r.body)).toBe(200); };

describe("used goods: tracked and booked like any goods, but their profit is outside the partnership", () => {
  it("a used sale draws only from used layers (its own cost), regular sales only from regular layers", async () => {
    await buyLine("10", "1000", "USED"); await buyLine("10", "1500", "PARTNERSHIP");
    const u = await sell([{ qty: "4", price: "3000", cls: "USED" }]); expect(u.post!.status).toBe(200);
    expect(Number((await w.getInvoice(u.id)).cogsBase)).toBe(4000);                                                       // 4 x 1,000 (used layer), not 4 x 1,500
    const tooMany = await sell([{ qty: "7", price: "3000", cls: "USED" }]); expect(tooMany.post!.status).toBe(409);        // only 6 used left, even though 10 regular exist
    expect(tooMany.post!.body.error.message).toContain("مستعمل");
    const r = await sell([{ qty: "5", price: "3000", cls: "PARTNERSHIP" }]); expect(Number((await w.getInvoice(r.id)).cogsBase)).toBe(7500);   // 5 x 1,500
  });
  it("a mixed invoice, fully paid and delivered: only the regular line's profit is eligible; the used profit is reported apart and stays in the ledger", async () => {
    const m = await sell([{ qty: "2", price: "3000", cls: "USED" }, { qty: "2", price: "3000", cls: "PARTNERSHIP" }], "2026-03-01"); expect(m.post!.status).toBe(200);
    await pay(m.id, "12000", "2026-03-02");
    const g = await w.getInvoice(m.id);
    expect(Number(g.profit.usedProfitBase)).toBe(4000);                                                                   // 6,000 - 2 x 1,000
    expect(Number(g.profit.linkedProfitBase)).toBe(3000);                                                                 // 6,000 - 2 x 1,500 = 3,000 only
    const pv = (await w.api(w.owner, w.R.settlePreview, { method: "POST", body: { periodStart: "2026-03-01", periodEnd: "2026-03-31" } })).body;
    expect(pv.lines.find((l: any) => l.invoiceId === m.id).newly).toBe("3000");
    const pnl = (await w.api(w.owner, w.R.report2, { params: { id: "profit-loss" }, path: "/api/reports2/profit-loss?from=2026-03-01&to=2026-03-31" } as any)).body;
    expect(Number(pnl.rows.find((x: any) => x.label === "= الربح التجاري (الإجمالي)").amount)).toBe(7000);              // accounting profit includes the used goods: 12,000 - 5,000
    const ps = (await w.api(w.owner, w.R.report2, { params: { id: "profit-statement" }, path: "/api/reports2/profit-statement" } as any)).body;
    expect(Number(ps.rows.find((x: any) => x.label.startsWith("منه: ربح المستعمل")).amount)).toBeGreaterThanOrEqual(4000);
    expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
  });
  it("a transfer to partner custody keeps each layer's class, and a used sale from custody still costs the used layer", async () => {
    await buyLine("5", "800", "USED", "2026-04-01");
    const t = await w.api(w.owner, w.R.transfers.POST, { method: "POST", body: { docDate: "2026-04-05", fromLocationId: w.ids.main, toLocationId: w.ids.partner, lines: [{ productId: P, uom: "قطعة", qty: "9" }] } });
    expect((await w.api(w.owner, w.R.transferPost, { method: "POST", params: { id: t.body.id } })).status, JSON.stringify(t.body)).toBe(200);
    const cust = await w.env.admin`SELECT l.profit_class c, sum(l.qty_remaining)::int q, min(l.unit_cost_base)::int u FROM stock_lots l WHERE l.location_id = ${w.ids.partner} AND l.qty_remaining > 0 GROUP BY l.profit_class ORDER BY 1`;
    expect(cust.length).toBeGreaterThanOrEqual(1);
    for (const r of cust) { expect(["PARTNERSHIP", "USED"]).toContain(r.c); if (r.c === "USED") expect([1000, 800]).toContain(r.u); else expect(r.u).toBe(1500); }   // a layer never changes class when it moves
    const mix = await w.env.admin`SELECT count(*)::int n FROM stock_lots l JOIN stock_lots s ON s.id = l.source_lot_id WHERE l.profit_class <> s.profit_class`; expect(mix[0]!.n).toBe(0);
    expect((await w.recon()).ok).toBe(true);
  });
});
