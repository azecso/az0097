import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("20000000"); P = await w.mkProduct("RE"); await w.buy({ product: P, qty: "100", price: "1000", date: "2026-01-05" }); });
afterAll(async () => { await w.env.teardown(); });
const cashNet = async (id: string) => Number((await w.env.admin`SELECT COALESCE(sum(amount),0)::text s FROM cash_movements WHERE doc_type = 'customer_receipt' AND doc_id = ${id}`)[0]!.s);
const iqdCash = async () => Number((await w.api(w.owner, w.R.cash)).body.find((c: any) => c.kind === "MAIN_CASH" && c.currency === "IQD").balance);

describe("editing a posted receipt again and again, then cancelling it: cash moves are never reversed twice", () => {
  let inv: string; let rc: string;
  it("100,000 invoice, 100,000 receipt, corrected to 80,000: collected 80,000, remaining 20,000, net cash +80,000 only", async () => {
    inv = (await w.sale({ product: P, qty: "50", price: "2000", date: "2026-03-01" })).id;
    const base = await iqdCash();
    const r = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-03-02", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "100000", allocations: [{ invoiceId: inv, amount: "100000" }] } });
    rc = r.body.id; await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc } }); expect(await iqdCash()).toBe(base + 100000);
    const ver = (await w.api(w.owner, w.R.receiptEdit, { params: { id: rc } })).body.version;
    const a = await w.api(w.owner, w.R.receiptAmend, { method: "POST", params: { id: rc }, body: { customerId: w.ids.customer, docDate: "2026-03-02", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "80000", allocations: [{ invoiceId: inv, amount: "80000" }], version: ver } });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const g = await w.getInvoice(inv); expect(Number(g.collected)).toBe(80000); expect(Number(g.outstanding)).toBe(20000); expect(await iqdCash()).toBe(base + 80000); expect(await cashNet(rc)).toBe(80000);
  });
  it("a second and a third edit, change of cash account, then cancel: still exactly one live movement, then zero", async () => {
    const edit = async (amount: string, cash: string) => { const ver = (await w.api(w.owner, w.R.receiptEdit, { params: { id: rc } })).body.version; return w.api(w.owner, w.R.receiptAmend, { method: "POST", params: { id: rc }, body: { customerId: w.ids.customer, docDate: "2026-03-02", cashAccountId: cash, currency: "IQD", amount, allocations: [{ invoiceId: inv, amount }], version: ver } }); };
    expect((await edit("60000", w.ids.cashIQD)).status).toBe(200); expect(await cashNet(rc)).toBe(60000);
    const rows = await w.env.admin`SELECT cash_account_id, sum(amount)::text s FROM cash_movements WHERE doc_id = ${rc} GROUP BY 1`; expect(rows).toHaveLength(1);
    const base = await iqdCash();
    const rv = await w.api(w.owner, w.R.receiptReverse, { method: "POST", params: { id: rc }, body: { reason: "إدخال خاطئ" } }); expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    expect(await cashNet(rc)).toBe(0); expect(await iqdCash()).toBe(base - 60000);                         // only the live 60,000 left; the earlier 100,000 / 80,000 were never reversed a second time
    expect(Number((await w.getInvoice(inv)).outstanding)).toBe(100000); expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
    expect(bal(await w.tb(), "1110")).toBe(20000000 - 100000 + 0 - 0 + 0);                                  // capital - purchase; the receipt left no trace in cash
  });
});
