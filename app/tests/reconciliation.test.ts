import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => {
  w = await makeWorld(); await w.fund("20000000"); P = await w.mkProduct("RC"); await w.buy({ product: P, qty: "100", price: "1000", date: "2026-01-05" });
  const i1 = (await w.sale({ product: P, qty: "10", price: "2000", date: "2026-02-01" })).id;
  const i2 = (await w.sale({ product: P, qty: "5", price: "2000", date: "2026-02-02", mode: "SEPARATE" })).id;
  const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-02-03", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "12000", allocations: [{ invoiceId: i1, amount: "12000" }] } });
  await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } }); void i2;
});
afterAll(async () => { await w.env.teardown(); });
const rec = async () => (await w.api(w.owner, w.R.reconcile)).body;

describe("reconciliation screen", () => {
  it("a normal book (sales, separate delivery not yet delivered, collections) reconciles on every check", async () => {
    const r = await rec(); expect(r.ok, JSON.stringify(r.checks.filter((c: any) => !c.ok))).toBe(true); expect(r.checks.map((c: any) => c.code)).toEqual(["TRIAL_BALANCE", "INVENTORY", "CASH", "RECEIVABLES", "DEFERRED_REVENUE", "CUSTOMER_CREDIT", "PARTNER_PROFIT", "PROFIT_RESERVE", "OUTSIDE_MARGIN"]);
  });
  it("an orphan cash movement is located: which account, the ledger figure, the movement figure and the difference", async () => {
    const acc = (await w.env.admin`SELECT id FROM cash_accounts WHERE kind = 'MAIN_CASH' AND currency = 'IQD'`)[0]!.id;
    await w.env.admin`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${w.env.companyId}, ${acc}, 777, 777, 'stray', gen_random_uuid())`;
    const r = await rec(); const c = r.checks.find((x: any) => x.code === "CASH"); expect(r.ok).toBe(false); expect(c.ok).toBe(false);
    expect(c.rows[0]).toMatchObject({ الفرق: "-777" });
  });
  it("owner only", async () => { expect((await w.api(w.acct, w.R.reconcile)).status).toBe(403); });
});
