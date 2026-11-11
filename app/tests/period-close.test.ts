import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("20000000"); P = await w.mkProduct("PC"); await w.buy({ product: P, qty: "100", price: "1000", date: "2026-01-05" }); });
afterAll(async () => { await w.env.teardown(); });
const close = (month: string) => w.api(w.owner, w.R.periods.POST, { method: "POST", body: { month } });
const snap = async (m: string) => (await w.env.admin`SELECT snapshot FROM accounting_periods WHERE period_month = ${m + "-01"}`)[0]!.snapshot;

describe("closing a month", () => {
  it("the snapshot contains only entries dated up to the month end, even when later months already have movements", async () => {
    await w.sale({ product: P, qty: "10", price: "2000", date: "2026-02-10" });          // February sale
    await w.sale({ product: P, qty: "10", price: "5000", date: "2026-03-10" });          // March sale already entered
    expect((await close("2026-02")).status).toBe(200);
    const s = await snap("2026-02"); expect(s.asOf).toBe("2026-02-28");
    const ar = s.rows.find((r: any) => r.code === "1200"); expect(Number(ar.debit)).toBe(20000);          // not 70,000
    expect(s.balanced).toBe(true); expect(s.reconciliation.inventoryAsOfNow).toBeDefined();
    expect(bal(await w.tb(), "1200")).toBe(70000);                                       // the live ledger still has both
  });
  it("every kind of pending document blocks closing, not only invoices/purchases/expenses", async () => {
    const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-03-12", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "1000", allocations: [] } });
    expect(rc.status).toBe(200);
    const r = await close("2026-03"); expect(r.status).toBe(409); expect(r.body.error.code).toBe("DRAFTS_EXIST"); expect(r.body.error.message).toContain("customer_receipts");
    await w.api(w.owner, w.R.receiptId.DELETE, { method: "DELETE", params: { id: rc.body.id } });
  });
  it("a posting racing a close of the same month either lands before it or is refused after it — never inside a closed month", async () => {
    const inv = await w.sale({ product: P, qty: "1", price: "1000", date: "2026-03-20", noPost: true } as any);
    const [c, p] = await Promise.all([close("2026-03"), w.api(w.owner, w.R.invoicePost, { method: "POST", params: { id: inv.body.id } })]);
    const closedFirst = c.status === 200 && p.status === 409;
    const postedFirst = p.status === 200 && (c.status === 409 || c.status === 200);
    expect(closedFirst || postedFirst, JSON.stringify([c.body, p.body])).toBe(true);
    if (c.status === 200) {                                                              // whatever the order, the stored snapshot equals the ledger as of month end at the moment of closing
      const s = await snap("2026-03"); const live = (await w.env.admin`SELECT COALESCE(sum(jl.debit_base),0)::text d FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.entry_date <= '2026-03-31'`)[0]!.d;
      expect(Number(s.totalDebit)).toBe(Number(live));
    }
  });
});
