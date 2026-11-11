import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, type World } from "./world";
import { split5050 } from "@/lib/money";

let w: World; let P: string;
beforeAll(async () => {
  w = await makeWorld(); await w.fund("20000000");
  const r = await w.api(w.acct, w.R.capital.POST, { method: "POST", body: { kind: "INJECTION", docDate: "2026-01-01", cashAccountId: w.ids.cashUSD, currency: "USD", exchangeRate: "1480", amount: "10000", reason: "usd" } });
  await w.api(w.owner, w.R.capitalApprove, { method: "POST", params: { id: r.body.id }, body: {} });
  P = await w.mkProduct("PC"); await w.buy({ product: P, qty: "100", price: "4", date: "2026-01-10", currency: "USD", rate: "1480" } as any);        // unit cost 5,920 IQD
});
afterAll(async () => { await w.env.teardown(); });

describe("profit, shares and payouts are in dinars whatever the invoice or receipt currency", () => {
  it("a USD invoice collected in USD at another rate: eligible profit in IQD from the ORIGINAL layer cost; the realised FX gain is a separate deduction line, not double counted", async () => {
    const inv = (await w.sale({ product: P, qty: "10", price: "10", date: "2026-02-15", currency: "USD", rate: "1500" })).id;          // 100 USD = 150,000 IQD; cost 10 x 5,920 = 59,200
    const rc = await w.api(w.owner, w.R.collect, { method: "POST", params: { id: inv }, body: { requestId: "pc-req-00001", docDate: "2026-02-20", cashAccountId: w.ids.cashUSD, currency: "USD", exchangeRate: "1520", amount: "100" } });
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
    const pv = (await w.api(w.owner, w.R.settlePreview, { method: "POST", body: { periodStart: "2026-01-01", periodEnd: "2026-03-31" } })).body;
    expect(pv.eligibleProfit).toBe("90800");                                                    // 150,000 - 59,200 at the invoice rate and the layer's cost; NOT 152,000 - 59,200
    expect(pv.deductions).toBe("-2000");                                                        // the +2,000 realised FX gain enters once, through the ledger deductions
    expect(pv.periodResult).toBe("92800"); expect(pv.distributable).toBe("92800"); expect(pv.ownerShare).toBe("46400"); expect(pv.partnerShare).toBe("46400");
  });
  it("the odd dinar: the partner gets the floor, the owner the remainder (stated policy), the total is exact", () => {
    expect(split5050("100001", "IQD")).toEqual({ partner: expect.anything(), owner: expect.anything() });
    const s = split5050("100001", "IQD"); expect(s.partner.toString()).toBe("50000"); expect(s.owner.toString()).toBe("50001"); expect(s.partner.plus(s.owner).toString()).toBe("100001");
    const z = split5050("0", "IQD"); expect(z.partner.toString()).toBe("0"); expect(z.owner.toString()).toBe("0");
  });
  it("profit is paid in dinars only: a payout from the USD account is refused even though dollars are in the till", async () => {
    const d = await w.api(w.owner, w.R.settlements.POST, { method: "POST", body: { periodStart: "2026-01-01", periodEnd: "2026-03-31" } });
    expect((await w.api(w.owner, w.R.settleApprove, { method: "POST", params: { id: d.body.id }, body: {} })).status).toBe(200);
    const pay = (cash: string, key: string) => w.api(w.owner, w.R.payouts.POST, { method: "POST", body: { settlementId: d.body.id, partnerKind: "OWNER", amount: "1000", deductAdvances: "0", cashAccountId: cash, docDate: "2026-04-01", idempotencyKey: key } });
    expect((await pay(w.ids.cashUSD, "pc-pay-0001")).body.error.code).toBe("BAD_CASH_ACCOUNT");
    expect((await pay(w.ids.cashIQD, "pc-pay-0002")).status).toBe(200);
  });
});
