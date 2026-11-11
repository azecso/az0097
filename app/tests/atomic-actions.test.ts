import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("20000000"); P = await w.mkProduct("AT"); await w.buy({ product: P, qty: "100", price: "1000", date: "2026-01-05" }); });
afterAll(async () => { await w.env.teardown(); });
const collect = (inv: string, b: Record<string, unknown>, s = w.owner) => w.api(s, w.R.collect, { method: "POST", params: { id: inv }, body: { docDate: "2026-03-10", cashAccountId: w.ids.cashIQD, currency: "IQD", ...b } });
const receipts = async () => (await w.env.admin`SELECT count(*)::int n FROM customer_receipts WHERE status <> 'REVERSED'`)[0]!.n as number;

describe("collect from the invoice: one atomic, idempotent action", () => {
  let inv: string;
  it("creates and posts a linked receipt in one call; a double click / retry returns the same receipt", async () => {
    inv = (await w.sale({ product: P, qty: "10", price: "2000", date: "2026-03-01" })).id;
    const before = await receipts();
    const a = await collect(inv, { requestId: "req-collect-0001", amount: "5000" }); expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ applied: "5000", outstanding: "15000", status: "PARTIAL" }); expect(a.body.docNo).toMatch(/^RC-/);
    const dup = await Promise.all([collect(inv, { requestId: "req-collect-0001", amount: "5000" }), collect(inv, { requestId: "req-collect-0001", amount: "5000" })]);
    for (const x of dup) { expect(x.status).toBe(200); expect(x.body.receiptId).toBe(a.body.receiptId); }
    expect(await receipts()).toBe(before + 1); expect(Number((await w.getInvoice(inv)).outstanding)).toBe(15000);
  });
  it("a failed attempt leaves NO orphan draft and the same key can be retried", async () => {
    const before = await receipts();
    const bad = await collect(inv, { requestId: "req-collect-0002", amount: "5000", cashAccountId: w.ids.cashUSD, currency: "USD" }); expect(bad.status).toBe(400); expect(bad.body.error.code).toBe("SETTLEMENT_RATE_REQUIRED");
    expect(await receipts()).toBe(before);
    const ok = await collect(inv, { requestId: "req-collect-0002", amount: "5000" }); expect(ok.status).toBe(200);                          // same key, now valid
    expect(await receipts()).toBe(before + 1);
  });
  it("cannot collect more than owed beyond the invoice: the surplus becomes customer credit, and a settled invoice refuses", async () => {
    const r = await collect(inv, { requestId: "req-collect-0003", amount: "12000" }); expect(r.status).toBe(200); expect(r.body).toMatchObject({ applied: "10000", surplusToCredit: "2000", status: "PAID" });
    expect((await collect(inv, { requestId: "req-collect-0004", amount: "1" })).body.error.code).toBe("ALREADY_SETTLED");
    expect((await w.tb()).balanced).toBe(true);
  });
  it("USD receipt against an IQD invoice through the explicit rate, from the same endpoint", async () => {
    const i2 = (await w.sale({ product: P, qty: "1", price: "150000", date: "2026-03-02" })).id;
    const r = await collect(i2, { requestId: "req-collect-0005", amount: "100", currency: "USD", cashAccountId: w.ids.cashUSD, exchangeRate: "1520", settlementRate: "1500" });
    expect(r.status, JSON.stringify(r.body)).toBe(200); expect(r.body).toMatchObject({ applied: "150000", status: "PAID" }); expect(bal(await w.tb(), "7100")).toBe(-2000);
  });
  it("an unposted invoice is refused with a clear reason (permissions are covered by the automatic route sweep in security.test)", async () => {
    const d1 = (await w.sale({ product: P, qty: "1", price: "1000", date: "2026-03-03", noPost: true } as any)).body.id;
    expect((await collect(d1, { requestId: "req-collect-0006", amount: "1" })).body.error.code).toBe("INVOICE_NOT_POSTED");
  });
});

describe("pay from the purchase: one atomic, idempotent action", () => {
  it("creates and posts a payment linked to the supplier and the invoice; retries are harmless; the supplier statement agrees", async () => {
    const po = await w.api(w.owner, w.R.purchases.POST, { method: "POST", body: { supplierId: w.ids.supplier, docDate: "2026-03-05", paymentType: "CREDIT", currency: "IQD", lines: [{ productId: P, uom: "قطعة", qty: "10", unitPrice: "1000" }] } });
    expect((await w.api(w.owner, w.R.purchasePost, { method: "POST", params: { id: po.body.id } })).status).toBe(200);
    const pay = (b: Record<string, unknown>) => w.api(w.owner, w.R.payPurchase, { method: "POST", params: { id: po.body.id }, body: { docDate: "2026-03-10", cashAccountId: w.ids.cashIQD, currency: "IQD", ...b } });
    const a = await pay({ requestId: "req-pay-000001", amount: "4000" }); expect(a.status, JSON.stringify(a.body)).toBe(200); expect(a.body.outstanding).toBe("6000"); expect(a.body.docNo).toMatch(/^PV-/);
    const b = await pay({ requestId: "req-pay-000001", amount: "4000" }); expect(b.body.paymentId).toBe(a.body.paymentId);
    expect((await pay({ requestId: "req-pay-000002", amount: "7000" })).body.error.code).toBe("OVER_ALLOCATION");
    expect((await pay({ requestId: "req-pay-000003", amount: "6000" })).body.outstanding).toBe("0"); expect((await pay({ requestId: "req-pay-000004", amount: "1" })).body.error.code).toBe("ALREADY_SETTLED");
    expect((await w.tb()).balanced).toBe(true);
  });
});
