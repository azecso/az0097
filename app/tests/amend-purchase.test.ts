import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("30000000"); P = await w.mkProduct("AP"); });
afterAll(async () => { await w.env.teardown(); });

const pbody = (g: any, qty: string, price: string, extra: Record<string, unknown> = {}) => ({ supplierId: g.supplierId, docDate: g.docDate, paymentType: g.paymentType, cashAccountId: g.cashAccountId, dueDate: g.dueDate, currency: g.currency, exchangeRate: g.exchangeRate,
  lines: [{ productId: P, uom: "قطعة", qty, unitPrice: price }], charges: [], version: g.version, ...extra });
const getP = async (id: string) => (await w.api(w.owner, w.R.purchaseId.GET, { params: { id } })).body;
const amendP = (id: string, b: unknown) => w.api(w.owner, w.R.purchaseAmend, { method: "POST", params: { id }, body: b });
const cashNet = async (acct: string) => Number((await w.env.admin`SELECT COALESCE(sum(amount),0)::text AS s FROM cash_movements WHERE cash_account_id = ${acct}`)[0]!.s);
const stockQty = async () => (await w.api(w.owner, w.R.stock)).body.filter((s: any) => s.productId === P).reduce((a: number, s: any) => a + Number(s.qty), 0);
const pay = async (pid: string, amount: string, date = "2026-02-10") => { const r = await w.api(w.owner, w.R.payPurchase, { method: "POST", params: { id: pid }, body: { requestId: `rq-${Math.random().toString(36).slice(2)}-${amount}`, docDate: date, cashAccountId: w.ids.cashIQD, currency: "IQD", amount } }); expect(r.status).toBe(200); return r.body.paymentId as string; };

describe("amend a posted purchase invoice", () => {
  it("cash purchase: same number, stock and cash follow, old record hidden, ledger balanced", async () => {
    const c0 = await cashNet(w.ids.cashIQD);
    const id = (await w.buy({ product: P, qty: "10", price: "1000", date: "2026-02-01", type: "CASH" })).id; const g = await getP(id);
    expect(await cashNet(w.ids.cashIQD) - c0).toBe(-10000);
    const r = await amendP(id, pbody(g, "8", "1500")); expect(r.status).toBe(200); expect(r.body.docNo).toBe(g.docNo);
    const n = await getP(r.body.id); expect(Number(n.total)).toBe(12000);
    expect(await cashNet(w.ids.cashIQD) - c0).toBe(-12000); expect(await stockQty()).toBe(8);
    const list = (await w.api(w.owner, w.R.purchases.GET)).body as any[]; expect(list.filter((x) => x.docNo === g.docNo && x.status === "POSTED")).toHaveLength(1); expect(list.some((x) => String(x.docNo).includes("~r") && x.status === "POSTED")).toBe(false);
    expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
    const again = await amendP(r.body.id, pbody(n, "8", "1000")); expect(again.status).toBe(200); expect(await cashNet(w.ids.cashIQD) - c0).toBe(-8000);
  });
  it("credit purchase with a real payment: payment stays linked; lower total leaves an advance to the supplier; higher total leaves a remainder", async () => {
    const id = (await w.buy({ product: P, qty: "10", price: "1000", date: "2026-02-05", type: "CREDIT" })).id; const g = await getP(id);
    const pid = await pay(id, "6000"); const c0 = await cashNet(w.ids.cashIQD);
    const dn = await amendP(id, pbody(g, "4", "1000")); expect(dn.status).toBe(200);        // 4000 < 6000 paid
    let n = await getP(dn.body.id); expect(n).toMatchObject({ docNo: g.docNo, paid: "4000.0000", outstanding: "0" });
    expect(await cashNet(w.ids.cashIQD)).toBe(c0);                                        // real cash never touched
    expect((await w.api(w.owner, w.R.paymentId.GET, { params: { id: pid } })).body.status).toBe("POSTED");
    const up = await amendP(dn.body.id, pbody(n, "20", "1000")); expect(up.status).toBe(200);
    n = await getP(up.body.id); expect(Number(n.outstanding)).toBe(16000); expect(await cashNet(w.ids.cashIQD)).toBe(c0);
    expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
  });
  it("the document history shows the whole chain of purchase versions and who amended", async () => {
    const id = (await w.buy({ product: P, qty: "1", price: "500", date: "2026-02-25", type: "CASH" })).id; const g = await getP(id);
    const r1 = await amendP(id, pbody(g, "2", "500")); expect(r1.status).toBe(200);
    const hist = await import("@/app/api/document-history/[kind]/[id]/route");
    const h = (await w.api(w.owner, hist.GET, { params: { kind: "purchases", id: r1.body.id } })).body;
    expect(h.chain).toHaveLength(2); expect(h.chain.filter((c: any) => c.replaced)).toHaveLength(1); expect(h.events.some((e: any) => e.action === "purchase.amend")).toBe(true);
  });
  it("refused with a clear path when the goods were already sold; nothing changes", async () => {
    const id = (await w.buy({ product: P, qty: "5", price: "700", date: "2026-02-20", type: "CASH" })).id; const g = await getP(id);
    const sold = await w.sale({ product: P, qty: String(await stockQty()), price: "2000", date: "2026-03-01", type: "CREDIT" }); expect(sold.status).toBe(200);   // sells everything, this lot included
    const r = await amendP(id, pbody(g, "5", "900")); expect(r.status).toBe(409); expect(r.body.error.code).toBe("PURCHASE_LOT_CONSUMED");
    expect((await getP(id)).status).toBe("POSTED"); expect((await w.tb()).balanced).toBe(true);
  });
});

describe("amend a supplier payment voucher", () => {
  it("amount/date/account edit keeps the number; cash follows; cancel after edit does not reverse cash twice", async () => {
    const id = (await w.buy({ product: P, qty: "10", price: "1000", date: "2026-04-01", type: "CREDIT" })).id; const c0 = await cashNet(w.ids.cashIQD);
    const pid = await pay(id, "5000", "2026-04-02"); const form = (await w.api(w.owner, w.R.paymentEdit, { params: { id: pid } })).body; expect(form.allocations[0].outstandingWithout).toBe("10000");
    const g = await getP(id);
    const e = await w.api(w.owner, w.R.paymentAmend, { method: "POST", params: { id: pid }, body: { supplierId: g.supplierId, docDate: "2026-04-03", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "3000", allocations: [{ purchaseId: id, amount: "3000" }], version: form.version } });
    expect(e.status).toBe(200); expect(e.body.docNo).toBe(form.docNo); expect(await cashNet(w.ids.cashIQD) - c0).toBe(-3000); expect(Number((await getP(id)).outstanding)).toBe(7000);
    const f2 = (await w.api(w.owner, w.R.paymentEdit, { params: { id: pid } })).body;
    const e2 = await w.api(w.owner, w.R.paymentAmend, { method: "POST", params: { id: pid }, body: { supplierId: g.supplierId, docDate: "2026-04-03", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "4000", allocations: [{ purchaseId: id, amount: "4000" }], version: f2.version } });
    expect(e2.status).toBe(200); expect(await cashNet(w.ids.cashIQD) - c0).toBe(-4000);
    expect((await w.api(w.owner, w.R.paymentReverse, { method: "POST", params: { id: pid }, body: { reason: "إلغاء السند" } })).status).toBe(200);
    expect(await cashNet(w.ids.cashIQD)).toBe(c0); expect(Number((await getP(id)).outstanding)).toBe(10000);
    expect((await w.api(w.owner, w.R.paymentAmend, { method: "POST", params: { id: pid }, body: { supplierId: g.supplierId, docDate: "2026-04-03", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "1", allocations: [], version: 1 } })).status).toBeGreaterThanOrEqual(400);
    expect((await w.tb()).balanced).toBe(true);
  });
  it("over-allocation on edit is refused and rolls everything back", async () => {
    const id = (await w.buy({ product: P, qty: "1", price: "1000", date: "2026-04-10", type: "CREDIT" })).id; const g = await getP(id); const pid = await pay(id, "500", "2026-04-11"); const c0 = await cashNet(w.ids.cashIQD);
    const form = (await w.api(w.owner, w.R.paymentEdit, { params: { id: pid } })).body;
    const bad = await w.api(w.owner, w.R.paymentAmend, { method: "POST", params: { id: pid }, body: { supplierId: g.supplierId, docDate: "2026-04-11", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "5000", allocations: [{ purchaseId: id, amount: "5000" }], version: form.version } });
    expect(bad.status).toBe(409); expect(await cashNet(w.ids.cashIQD)).toBe(c0); expect((await w.api(w.owner, w.R.paymentId.GET, { params: { id: pid } })).body.status).toBe("POSTED");
    void bal;
  });
});
