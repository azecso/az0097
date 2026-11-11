import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("30000000"); P = await w.mkProduct("XC"); await w.buy({ product: P, qty: "500", price: "1000", date: "2026-01-05" }); });
afterAll(async () => { await w.env.teardown(); });
const rcpt = (b: Record<string, unknown>) => w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-03-10", ...b } });
const post = (id: string) => w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id } });

describe("a receipt in another currency settles an invoice only through an explicit, stored conversion rate", () => {
  it("IQD invoice paid with 100 USD: needs the rate; at 1,500 it settles 150,000; cash is booked at the day rate and the difference is realised FX", async () => {
    const inv = (await w.sale({ product: P, qty: "10", price: "15000", date: "2026-03-01" })).id;                 // 150,000 IQD
    const base = { cashAccountId: w.ids.cashUSD, currency: "USD", exchangeRate: "1520", amount: "100", allocations: [{ invoiceId: inv, amount: "150000" }] };
    expect((await rcpt(base)).body.error.code).toBe("SETTLEMENT_RATE_REQUIRED");                                   // never a silent conversion
    expect((await rcpt({ ...base, amount: "99", settlementRate: "1500" })).body.error.code).toBe("ALLOCATIONS_EXCEED_AMOUNT");   // 99$ = 148,500 at the agreed rate, not enough for 150,000
    const r = await rcpt({ ...base, settlementRate: "1500" }); expect(r.status, JSON.stringify(r.body)).toBe(200);
    const p = await post(r.body.id); expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.fxDiffBase).toBe("2000.0000");                                                                    // 100 x 1,520 = 152,000 cash vs 150,000 settled
    expect(Number((await w.getInvoice(inv)).outstanding)).toBe(0);
    const tb = await w.tb(); expect(tb.balanced).toBe(true); expect(bal(tb, "1200")).toBe(0); expect(bal(tb, "7100")).toBe(-2000);
    const usd = (await w.api(w.owner, w.R.cash)).body.find((c: any) => c.currency === "USD"); expect(Number(usd.balance)).toBe(100);
  });
  it("USD invoice paid in dinars: 300,000 IQD at 1,500 settles 200 USD; leftover received money becomes customer credit in the RECEIPT currency", async () => {
    const inv = (await w.sale({ product: P, qty: "10", price: "20", date: "2026-03-02", currency: "USD", rate: "1500" })).id;      // 200 USD
    const r = await rcpt({ cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "330000", settlementRate: "1500", allocations: [{ invoiceId: inv, amount: "200" }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200); expect((await post(r.body.id)).status).toBe(200);
    expect(Number((await w.getInvoice(inv)).outstanding)).toBe(0);
    const cr = await w.env.admin`SELECT COALESCE(sum(jl.credit_base - jl.debit_base),0)::text b, string_agg(DISTINCT jl.currency, ',') cur FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '2400'`;
    expect(cr[0]!.b).toBe("30000.0000"); expect(cr[0]!.cur).toBe("IQD");                                          // 330,000 - 300,000 used
    expect((await w.tb()).balanced).toBe(true);
  });
  it("one receipt cannot settle invoices of two currencies; external profit refuses a cross-currency receipt", async () => {
    const a = (await w.sale({ product: P, qty: "1", price: "1000", date: "2026-03-03" })).id, b = (await w.sale({ product: P, qty: "1", price: "5", date: "2026-03-03", currency: "USD", rate: "1500" })).id;
    expect((await rcpt({ cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "9000", settlementRate: "1500", allocations: [{ invoiceId: a, amount: "1000" }, { invoiceId: b, amount: "5" }] })).body.error.code).toBe("MIXED_INVOICE_CURRENCIES");
    expect((await rcpt({ cashAccountId: w.ids.cashUSD, currency: "USD", amount: "1", settlementRate: "1500", allocations: [{ invoiceId: a, amount: "0", externalAmount: "100" }] })).status).toBe(400);
  });
  it("the same-currency flow is unchanged (no rate needed, none stored)", async () => {
    const inv = (await w.sale({ product: P, qty: "1", price: "7000", date: "2026-03-04" })).id;
    const r = await rcpt({ cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "7000", allocations: [{ invoiceId: inv, amount: "7000" }] }); expect((await post(r.body.id)).status).toBe(200);
    expect((await w.env.admin`SELECT settlement_rate FROM customer_receipts WHERE id = ${r.body.id}`)[0]!.settlement_rate).toBeNull();
  });
});
