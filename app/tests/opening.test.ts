import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w2: World;
beforeAll(async () => { w2 = await makeWorld(); });
afterAll(async () => { await w2.env.teardown(); });

describe("opening balances: balanced, explained, once", () => {
  const add = (b: Record<string, unknown>) => w2.api(w2.owner, w2.R.opening.POST, { method: "POST", body: { asOf: "2026-01-01", ...b } });
  it("an unbalanced opening is refused with the difference shown, and NO plug entry is created", async () => {
    const P = await w2.mkProduct("OPEN1");
    await add({ kind: "CAPITAL", amount: "10000000" });
    await add({ kind: "CASH", cashAccountId: w2.ids.cashIQD, amount: "3250000" });
    await add({ kind: "INVENTORY_LAYER", productId: P, locationId: w2.ids.main, qtyBase: "100", amount: "5400000", receivedAt: "2025-12-15" });
    const eq = (await w2.api(w2.owner, w2.R.opening.GET)).body.equation;
    expect(Number(eq.difference)).toBe(8650000 - 10000000);
    const r = await w2.api(w2.owner, w2.R.openingPost, { method: "POST" });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe("OPENING_IMBALANCE");
    expect((await w2.tb()).rows.length).toBe(0);                                       // nothing posted, no 3900 plug
    expect((await w2.api(w2.owner, w2.R.opening.POST, { method: "POST", body: { asOf: "2026-01-01", kind: "RETAINED_EARNINGS", amount: "1350000", note: "x" } })).status).toBe(400);   // must be documented
  });
  it("balances with customers, suppliers and documented retained earnings; posts one entry, creates dated FIFO layers and allocatable opening documents", async () => {
    const cus = w2.ids.customer, sup = w2.ids.supplier;
    await add({ kind: "CUSTOMER", contactId: cus, currency: "IQD", amount: "2100000" });
    await add({ kind: "SUPPLIER", contactId: sup, currency: "IQD", amount: "750000" });
    await add({ kind: "RETAINED_EARNINGS", amount: "0.0001", note: "placeholder" }).then(async (r) => { if (r.status === 200) await w2.api(w2.owner, w2.R.opening.GET); });
    const eq = (await w2.api(w2.owner, w2.R.opening.GET)).body.equation;
    expect(Number(eq.assets)).toBe(3250000 + 5400000 + 2100000); expect(Number(eq.liabilities)).toBe(750000);
    // required retained earnings = assets - liabilities - capital = 10,750,000 - 750,000 - 10,000,000 = 0 -> already balanced except the 0.0001 placeholder
    const rows = (await w2.api(w2.owner, w2.R.opening.GET)).body.rows;
    const ph = rows.find((r: any) => r.kind === "RETAINED_EARNINGS"); if (ph) await w2.api(w2.owner, (await import("@/app/api/opening/[id]/route")).DELETE, { method: "DELETE", params: { id: ph.id } });
    expect(Number((await w2.api(w2.owner, w2.R.opening.GET)).body.equation.difference)).toBe(0);
    expect((await w2.api(w2.acct, w2.R.openingPost, { method: "POST" })).status).toBe(403);
    const ok = await w2.api(w2.owner, w2.R.openingPost, { method: "POST" });
    expect(ok.status).toBe(200);
    const tb = await w2.tb();
    expect(tb.balanced).toBe(true); expect(bal(tb, "3900")).toBe(0);
    expect(bal(tb, "1110")).toBe(3250000); expect(bal(tb, "1300")).toBe(5400000); expect(bal(tb, "1200")).toBe(2100000); expect(-bal(tb, "2100")).toBe(750000); expect(-bal(tb, "3100")).toBe(10000000);
    expect((await w2.recon()).ok).toBe(true);
    const lot = (await w2.api(w2.owner, w2.R.lots, { params: { id: (await w2.api(w2.owner, w2.R.products.GET)).body[0].id } })).body[0];
    expect(lot.receivedAt.slice(0, 10)).toBe("2025-12-15"); expect(Number(lot.unitCostBase)).toBe(54000);
    expect((await w2.api(w2.owner, w2.R.opening.POST, { method: "POST", body: { asOf: "2026-01-01", kind: "CAPITAL", amount: "1" } })).body.error.code).toBe("OPENING_ALREADY_POSTED");
    expect((await w2.api(w2.owner, w2.R.openingPost, { method: "POST" })).body.error.code).toBe("OPENING_ALREADY_POSTED");
    // the opening receivable is a real document: collect part of it
    const inv = (await w2.api(w2.owner, w2.R.receivables)).body.find((x: any) => x.customerId === cus);
    expect(Number(inv.outstanding)).toBe(2100000);
    const rc = await w2.api(w2.owner, w2.R.receipts.POST, { method: "POST", body: { customerId: cus, docDate: "2026-02-01", cashAccountId: w2.ids.cashIQD, currency: "IQD", amount: "1000000", allocations: [{ invoiceId: inv.id, amount: "1000000" }] } });
    expect((await w2.api(w2.owner, w2.R.receiptPost, { method: "POST", params: { id: rc.body.id } })).status).toBe(200);
    expect(Number((await w2.api(w2.owner, w2.R.receivables)).body.find((x: any) => x.customerId === cus).outstanding)).toBe(1100000);
  });
});

