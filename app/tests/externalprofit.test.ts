import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("10000000"); P = await w.mkProduct("EX"); await w.buy({ product: P, qty: "100", price: "800", date: "2026-02-01" }); });
afterAll(async () => { await w.env.teardown(); });

const receipt = (inv: string, cash: string, o: Record<string, unknown>, s = w.owner) =>
  w.api(s, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-03-05", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: cash, allocations: [{ invoiceId: inv, amount: cash, ...o }] } });
const post = (id: string) => w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id } });
const ov = async () => (await w.api(w.owner, w.R.profits.GET)).body;

describe("invoice 900 (cost 800): 800 collected in cash, 100 profit was distributed outside the system", () => {
  let inv: string; let rc: string;
  it("the receipt closes the invoice, cash grows by 800 only, the 100 goes to 'distributed outside' split 50/50, books stay balanced", async () => {
    inv = (await w.sale({ product: P, qty: "1", price: "900", date: "2026-03-01" })).id;
    const before = await w.tb();
    const r = await receipt(inv, "800", { externalAmount: "100", externalNote: "ربح سُلِّم للشركاء مباشرة" }); expect(r.status).toBe(200); rc = r.body.id;
    expect((await post(rc)).status).toBe(200);
    const tb = await w.tb(); expect(tb.balanced).toBe(true);
    expect(bal(tb, "1110") - bal(before, "1110")).toBe(800); expect(bal(tb, "3500")).toBe(100); expect(bal(tb, "1200") - bal(before, "1200")).toBe(-900);
    const parts = await w.env.admin`SELECT p.kind, sum(jl.debit_base)::text AS d FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id JOIN partners p ON p.id = jl.partner_id WHERE a.code = '3500' GROUP BY p.kind ORDER BY p.kind`;
    expect(parts.map((x: any) => [x.kind, Number(x.d)])).toEqual([["OWNER", 50], ["PARTNER", 50]]);
    const g = await w.getInvoice(inv); expect(g).toMatchObject({ collected: "800.0000", external: "100.0000", outstanding: "0" });
  });
  it("the invoice list and customer summary count it as fully paid; the report shows collected vs external", async () => {
    const row = (await w.api(w.owner, w.R.invoices.GET)).body.find((x: any) => x.id === inv); expect(Number(row.outstanding)).toBe(0);
    const rep = (await w.api(w.owner, w.R.repExternal, { path: "/api/reports/external-profits" })).body;
    expect(rep.rows).toHaveLength(1); expect(rep.rows[0]).toMatchObject({ invoiceNo: expect.stringMatching(/^INV-/), cash: "800.0000", external: "100.0000", note: "ربح سُلِّم للشركاء مباشرة" });
    expect(rep.totals).toMatchObject({ cash: "800", external: "100", perPartner: "50" });
  });
  it("this profit is NOT distributable again; the statement shows it as already given outside", async () => {
    const o = await ov(); expect(o.collectedProfit).toBe("100"); expect(o.newlyEligible).toBe("0"); expect(o.distributable).toBe("0");
    expect(o.externalDistributed).toBe("100"); expect(o.people.map((p: any) => p.externalDistributed)).toEqual(["50", "50"]);
  });
  it("the printed receipt shows the FULL amount (900, like the invoice); the split stays available for the reports", async () => {
    const g = (await w.api(w.owner, w.R.receiptId.GET, { params: { id: rc } })).body;
    expect(g).toMatchObject({ total: "900", cashAmount: "800.0000", external: "100" }); expect(g.allocations).toHaveLength(1);
    expect(g.allocations[0]).toMatchObject({ invoiceNet: "900.0000", amount: "900.0000", paidToDate: "900.0000", remaining: "0", state: "PAID" });
  });
  it("reversing the receipt restores everything: invoice open again, cash back, nothing external", async () => {
    expect((await w.api(w.owner, w.R.receiptReverse, { method: "POST", params: { id: rc }, body: { reason: "اختبار" } })).status).toBe(200);
    expect((await w.getInvoice(inv)).outstanding).toBe("900"); const o = await ov(); expect(o.externalDistributed).toBe("0"); expect((await w.tb()).balanced).toBe(true);
  });
});

describe("external profit smaller than the invoice profit, and the safety rules", () => {
  it("60 outside of a 100 profit: the remaining 40 is still distributable (20/20)", async () => {
    const inv = (await w.sale({ product: P, qty: "1", price: "900", date: "2026-03-10" })).id;
    const r = await receipt(inv, "840", { externalAmount: "60", externalNote: "ربح جزئي خارجي" }); expect((await post(r.body.id)).status).toBe(200);
    const o = await ov(); expect(o.newlyEligible).toBe("40"); expect(o.distributable).toBe("40"); expect(o.shares).toEqual({ owner: "20", partner: "20" });
  });
  it("owner only, IQD cash only, note required, never above what is still owed on the invoice", async () => {
    const inv = (await w.sale({ product: P, qty: "1", price: "900", date: "2026-03-12" })).id;
    expect((await receipt(inv, "800", { externalAmount: "100", externalNote: "x y z" }, w.acct)).body.error.code).toBe("EXTERNAL_PROFIT_OWNER_ONLY");
    expect((await receipt(inv, "800", { externalAmount: "100", externalNote: "" })).status).toBe(200);                       // note is optional: a default text is stored
    expect((await receipt(inv, "800", { externalAmount: "101", externalNote: "زيادة" })).body.error.code).toBe("OVER_ALLOCATION");
    expect((await receipt(inv, "0", { externalAmount: "0" })).status).toBe(400);
  });
  it("external profit cannot be used on a credit-application receipt", async () => {
    const inv = (await w.sale({ product: P, qty: "1", price: "900", date: "2026-03-14" })).id;
    const r = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-03-15", kind: "CREDIT_APPLICATION", currency: "IQD", amount: "900", allocations: [{ invoiceId: inv, amount: "800", externalAmount: "100", externalNote: "لا يجوز" }] } });
    expect(r.status).toBe(400);
  });
});
