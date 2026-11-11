import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, type World } from "./world";

let w: World; let P: string; let s1: string, s2: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("2000000"); P = await w.mkProduct("LQ"); await w.buy({ product: P, qty: "100", price: "1000", date: "2026-01-05" }); });
afterAll(async () => { await w.env.teardown(); });
const earn = async (date: string) => { const inv = (await w.sale({ product: P, qty: "50", price: "3000", date })).id;
  const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: date, cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "150000", allocations: [{ invoiceId: inv, amount: "150000" }] } });
  await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } }); };
const settle = async (a: string, b: string) => { const d = await w.api(w.owner, w.R.settlements.POST, { method: "POST", body: { periodStart: a, periodEnd: b } }); const r = await w.api(w.owner, w.R.settleApprove, { method: "POST", params: { id: d.body.id }, body: {} }); expect(r.status).toBe(200); return d.body.id as string; };
const pay = (settlementId: string, key: string, amount = "50000") => w.api(w.owner, w.R.payouts.POST, { method: "POST", body: { settlementId, partnerKind: "OWNER", amount, deductAdvances: "0", cashAccountId: w.ids.cashIQD, docDate: "2026-06-01", idempotencyKey: key } });
const liq = async () => (await w.api(w.owner, w.R.partners)).body.liquidity;

describe("distributable liquidity", () => {
  it("setup: two approved settlements (100,000 profit each => 50,000 per partner)", async () => {
    await earn("2026-02-01"); s1 = await settle("2026-01-01", "2026-03-31");
    await earn("2026-04-01"); s2 = await settle("2026-04-01", "2026-05-31");
  });
  it("customer credits, foreign-currency cash and restricted custody do not fund a dinar payout", async () => {
    await w.buy({ product: P, qty: "10", price: "1000", date: "2026-05-01" }); const before = Number((await liq()).available);
    // a customer overpays 40,000 -> that is owed back, not distributable
    const inv = (await w.sale({ product: P, qty: "1", price: "1000", date: "2026-05-10" })).id;
    const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-05-11", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "41000", allocations: [{ invoiceId: inv, amount: "1000" }] } });
    expect(rc.status, JSON.stringify(rc.body)).toBe(200); const rp = await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } }); expect(rp.status, JSON.stringify(rp.body)).toBe(200);
    const l = await liq(); expect(Number(l.available)).toBe(before + 1000);                                    // 41,000 cash in, 40,000 of it owed back as credit
    expect(l.byCurrency.IQD).toBeDefined();
  });
  it("two payouts of different settlements fired at the same time cannot both use the same liquidity", async () => {
    const l = await liq(); const target = 60000;
    const sup = await w.api(w.owner, w.R.purchases.POST, { method: "POST", body: { supplierId: w.ids.supplier, docDate: "2026-05-20", paymentType: "CREDIT", currency: "IQD", lines: [{ productId: P, uom: "قطعة", qty: "1", unitPrice: String(Number(l.available) - target) }] } });
    expect((await w.api(w.owner, w.R.purchasePost, { method: "POST", params: { id: sup.body.id } })).status).toBe(200);
    expect(Number((await liq()).available)).toBe(target);
    const [a, b] = await Promise.all([pay(s1, "conc-key-0001"), pay(s2, "conc-key-0002")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((x) => x.status === 409)!.body.error.code).toBe("INSUFFICIENT_LIQUIDITY");
    expect(Number((await liq()).available)).toBe(10000);
  });
  it("a repeated request with the same idempotency key is refused", async () => {
    expect((await pay(s1, "conc-key-0001", "100")).body.error.code).toBe("DUPLICATE_PAYOUT");
  });
});
