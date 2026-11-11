import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, type World } from "./world";

let w: World; let P: string; let cus: string;
beforeAll(async () => {
  w = await makeWorld(); await w.fund("20000000"); P = await w.mkProduct("CC"); await w.buy({ product: P, qty: "1000", price: "100", date: "2026-02-01" });
  cus = (await w.api(w.owner, w.R.contacts.POST, { method: "POST", body: { kind: "CUSTOMER", code: "CC1", name: "عميل العملات" } })).body.id;
});
afterAll(async () => { await w.env.teardown(); });
const rc = async (b: Record<string, unknown>) => { const r = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: cus, ...b } }); if (r.status !== 200) return r; return w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: r.body.id } }); };
const net2400 = async (cur: string) => (await w.env.admin`SELECT COALESCE(sum(jl.credit_base - jl.debit_base),0)::text b, COALESCE(sum(jl.amount_orig * CASE WHEN jl.credit_base > 0 THEN 1 ELSE -1 END),0)::text o FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '2400' AND jl.currency = ${cur} AND jl.contact_id = ${cus}`)[0]!;

describe("customer credit (2400) is per currency", () => {
  let s1: string, s2: string, s3: string;
  it("a USD overpayment becomes USD credit", async () => {
    s1 = (await w.sale({ product: P, qty: "10", price: "10", date: "2026-03-01", currency: "USD", rate: "1500", customer: cus })).id;
    s2 = (await w.sale({ product: P, qty: "10", price: "20000", date: "2026-03-01", customer: cus })).id;
    s3 = (await w.sale({ product: P, qty: "5", price: "10", date: "2026-03-01", currency: "USD", rate: "1500", customer: cus })).id;
    const r = await rc({ docDate: "2026-03-10", cashAccountId: w.ids.cashUSD, currency: "USD", exchangeRate: "1520", amount: "150", allocations: [{ invoiceId: s1, amount: "100" }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await net2400("USD")).toMatchObject({ b: "76000.0000", o: "50.0000" });
  });
  it("the USD credit cannot settle an IQD invoice, even though the dinar amount would be enough", async () => {
    const r = await rc({ docDate: "2026-03-11", kind: "CREDIT_APPLICATION", currency: "IQD", amount: "76000", allocations: [{ invoiceId: s2, amount: "76000" }] });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe("INSUFFICIENT_CREDIT");
  });
  it("it settles a USD invoice; the credit carrying value vs the invoice rate gives a realised FX result and 2400 returns to zero in both currency and dinars", async () => {
    const r = await rc({ docDate: "2026-03-12", kind: "CREDIT_APPLICATION", currency: "USD", amount: "50", allocations: [{ invoiceId: s3, amount: "50" }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await net2400("USD")).toMatchObject({ b: "0.0000", o: "0.0000" });
    const fx = (await w.env.admin`SELECT jl.credit_base::text c, jl.debit_base::text d FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id JOIN journal_entries je ON je.id = jl.entry_id WHERE a.code = '7100' AND je.memo LIKE 'تسوية رصيد دائن%'`)[0]!;
    expect(fx.c).toBe("1000.0000");                                                    // 50 USD owed at 1,520 carried, receivable cleared at 1,500
    expect((await w.tb()).balanced).toBe(true);
  });
});
