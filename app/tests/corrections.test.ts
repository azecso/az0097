import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("20000000"); P = await w.mkProduct("CR"); await w.buy({ product: P, qty: "200", price: "800", date: "2026-02-01" }); });
afterAll(async () => { await w.env.teardown(); });

const body = (inv: any, qty: string, price: string, extra: Record<string, unknown> = {}) => ({ customerId: inv.customerId, docDate: inv.docDate, saleType: inv.saleType, cashAccountId: inv.cashAccountId, dueDate: inv.dueDate, currency: inv.currency ?? "IQD", exchangeRate: inv.exchangeRate, deliveryMode: "WITH_INVOICE", discount: "0",
  lines: [{ productId: P, uom: "قطعة", qty, unitPrice: price, lineDiscount: "0" }], version: inv.version, ...extra });
const amend = (id: string, b: unknown) => w.api(w.owner, w.R.invoiceAmend, { method: "POST", params: { id }, body: b });
const cancel = (id: string, b: Record<string, unknown> = {}) => w.api(w.owner, w.R.invoiceReverse, { method: "POST", params: { id }, body: { reason: "سبب الإلغاء", ...b } });
const receipt = async (inv: string, cust: string, amount: string, date = "2026-05-02", acct = w.ids.cashIQD, cur = "IQD") => {
  const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: cust, docDate: date, cashAccountId: acct, currency: cur, amount, allocations: [{ invoiceId: inv, amount }] } });
  await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } }); return rc.body.id as string;
};
const cashNet = async (acct: string) => Number((await w.env.admin`SELECT COALESCE(sum(amount),0)::text AS s FROM cash_movements WHERE cash_account_id = ${acct}`)[0]!.s);

describe("cancelling an invoice that has money on it", () => {
  it("phantom receipt: REVERSE undoes cash and receivable", async () => {
    const c0 = await cashNet(w.ids.cashIQD);
    const inv = (await w.sale({ product: P, qty: "2", price: "1000", date: "2026-05-01", type: "CREDIT" })).id; const g = await w.getInvoice(inv);
    await receipt(inv, g.customerId, "700");
    expect((await cancel(inv)).body.error.code).toBe("HAS_RECEIPTS");                                   // never silently decided
    expect((await cancel(inv, { receiptHandling: "REVERSE" })).status).toBe(200);
    expect(await cashNet(w.ids.cashIQD)).toBe(c0); expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
  });
  it("real cash: KEEP_AS_CREDIT leaves the cash in the box as customer credit; nothing deleted", async () => {
    const c0 = await cashNet(w.ids.cashIQD), cr0 = bal(await w.tb(), "2400");
    const inv = (await w.sale({ product: P, qty: "2", price: "1000", date: "2026-05-03", type: "CREDIT" })).id; const g = await w.getInvoice(inv);
    const rc = await receipt(inv, g.customerId, "1500");
    expect((await cancel(inv, { receiptHandling: "KEEP_AS_CREDIT" })).status).toBe(200);
    expect(await cashNet(w.ids.cashIQD) - c0).toBe(1500); expect(bal(await w.tb(), "2400") - cr0).toBe(-1500);
    expect((await w.api(w.owner, w.R.receiptId.GET, { params: { id: rc } })).body.status).toBe("POSTED");
    expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
  });
  it("cash sale: KEEP_AS_CREDIT keeps the auto receipt's cash; default cancel still reverses it", async () => {
    const c0 = await cashNet(w.ids.cashIQD);
    const a = (await w.sale({ product: P, qty: "1", price: "2000", date: "2026-05-04", type: "CASH" })).id;
    expect((await cancel(a)).status).toBe(200); expect(await cashNet(w.ids.cashIQD)).toBe(c0);
    const b = (await w.sale({ product: P, qty: "1", price: "2000", date: "2026-05-04", type: "CASH" })).id;
    expect((await cancel(b, { receiptHandling: "KEEP_AS_CREDIT" })).status).toBe(200); expect(await cashNet(w.ids.cashIQD) - c0).toBe(2000); expect((await w.tb()).balanced).toBe(true);
  });
});

describe("amend: real receipts stay linked through repeated corrections", () => {
  it("three corrections up/down/up: one effective receipt, cash never duplicated or deleted, ledger keeps every entry", async () => {
    const c0 = await cashNet(w.ids.cashIQD);
    let id = (await w.sale({ product: P, qty: "2", price: "1000", date: "2026-05-05", type: "CREDIT" })).id; const g = await w.getInvoice(id);
    const rc = await receipt(id, g.customerId, "1200");
    const jBefore = Number((await w.env.admin`SELECT count(*)::int AS n FROM journal_entries`)[0]!.n);
    for (const [q, p, col, out] of [["1", "800", "800.0000", "0"], ["3", "1000", "800.0000", "2200"], ["1", "500", "500.0000", "0"]] as const) {
      const r = await amend(id, body(await w.getInvoice(id), q, p)); expect(r.status).toBe(200); id = r.body.id;
      const x = await w.getInvoice(id); expect(x).toMatchObject({ docNo: g.docNo, collected: col, outstanding: out });
      expect(await cashNet(w.ids.cashIQD) - c0).toBe(1200); expect((await w.tb()).balanced).toBe(true);
    }
    const eff = (await w.api(w.owner, w.R.receipts.GET)).body.filter((x: any) => x.id === rc && x.status === "POSTED"); expect(eff).toHaveLength(1);
    expect(Number((await w.env.admin`SELECT count(*)::int AS n FROM journal_entries`)[0]!.n)).toBeGreaterThan(jBefore);   // history kept, append-only
    expect((await w.recon()).ok).toBe(true);
  });
  it("cancelling a receipt that was edited does not reverse old cash twice", async () => {
    const c0 = await cashNet(w.ids.cashIQD);
    const inv = (await w.sale({ product: P, qty: "1", price: "5000", date: "2026-05-06", type: "CREDIT" })).id; const g = await w.getInvoice(inv);
    const rc = await receipt(inv, g.customerId, "3000");
    const f = (await w.api(w.owner, w.R.receiptEdit, { params: { id: rc } })).body;
    const e = await w.api(w.owner, w.R.receiptAmend, { method: "POST", params: { id: rc }, body: { customerId: g.customerId, docDate: "2026-05-07", kind: "CASH", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "2000", allocations: [{ invoiceId: inv, amount: "2000" }], version: f.version } });
    expect(e.status).toBe(200); expect(await cashNet(w.ids.cashIQD) - c0).toBe(2000);
    expect((await w.api(w.owner, w.R.receiptReverse, { method: "POST", params: { id: rc }, body: { reason: "إلغاء السند" } })).status).toBe(200);
    expect(await cashNet(w.ids.cashIQD)).toBe(c0); expect((await w.getInvoice(inv)).outstanding).toBe("5000");
  });
  it("USD invoice with a USD receipt: amend keeps the receipt and the base-currency books", async () => {
    const inv = (await w.sale({ product: P, qty: "1", price: "10", date: "2026-05-08", type: "CREDIT", currency: "USD", rate: "1450" })).id; const g = await w.getInvoice(inv);
    const c0 = await cashNet(w.ids.cashUSD);
    await receipt(inv, g.customerId, "4", "2026-05-09", w.ids.cashUSD, "USD");
    const r = await amend(inv, body(g, "1", "12", { currency: "USD", exchangeRate: "1450" })); expect(r.status).toBe(200);
    const x = await w.getInvoice(r.body.id); expect(x).toMatchObject({ docNo: g.docNo, collected: "4.0000", outstanding: "8" });
    expect(await cashNet(w.ids.cashUSD) - c0).toBe(4); expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
  });
  it("a refused amendment rolls back everything (receipt and invoice untouched)", async () => {
    const inv = (await w.sale({ product: P, qty: "1", price: "1000", date: "2026-05-10", type: "CREDIT" })).id; const g = await w.getInvoice(inv);
    const rc = await receipt(inv, g.customerId, "400"); const c0 = await cashNet(w.ids.cashIQD);
    const bad = await amend(inv, body(g, "100000", "1000")); expect(bad.status).toBeGreaterThanOrEqual(400);   // not enough stock
    expect((await w.getInvoice(inv)).status).toBe("POSTED"); expect(await cashNet(w.ids.cashIQD)).toBe(c0);
    expect((await w.api(w.owner, w.R.receiptId.GET, { params: { id: rc } })).body.status).toBe("POSTED");
  });
});
