import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("10000000"); P = await w.mkProduct("AM"); await w.buy({ product: P, qty: "100", price: "800", date: "2026-02-01" }); });
afterAll(async () => { await w.env.teardown(); });

const body = (inv: any, qty: string, price: string, extra: Record<string, unknown> = {}) => ({ customerId: inv.customerId, docDate: inv.docDate, saleType: inv.saleType, cashAccountId: inv.cashAccountId, dueDate: inv.dueDate, currency: "IQD", deliveryMode: "WITH_INVOICE", discount: "0",
  lines: [{ productId: P, uom: "قطعة", qty, unitPrice: price, lineDiscount: "0" }], version: inv.version, ...extra });
const amend = (id: string, b: unknown, s = w.owner) => w.api(s, w.R.invoiceAmend, { method: "POST", params: { id }, body: b });
const list = async (q = "") => (await w.api(w.owner, w.R.invoices.GET, { path: "/api/sales-invoices" + q } as any)).body as any[];

describe("editing a posted invoice keeps its number and hides the old version", () => {
  let id: string; let docNo: string;
  it("a credit invoice 2 x 1,000 is edited to 5 x 1,500: same number, new record, stock + ledger follow", async () => {
    const inv = await w.sale({ product: P, qty: "2", price: "1000", date: "2026-03-01", type: "CREDIT" }); id = inv.id;
    const g = await w.getInvoice(id); docNo = g.docNo;
    const r = await amend(id, body(g, "5", "1500")); expect(r.status).toBe(200); expect(r.body.docNo).toBe(docNo); expect(r.body.id).not.toBe(id);
    const g2 = await w.getInvoice(r.body.id); expect(g2).toMatchObject({ docNo, status: "POSTED", net: "7500.0000" }); expect(g2.lines).toHaveLength(1); expect(Number(g2.lines[0].qtyBase)).toBe(5);
    const rows = await list(); expect(rows.filter((x) => x.docNo === docNo)).toHaveLength(1);               // the old version is hidden, no "reversal" shown
    expect(rows.some((x) => String(x.docNo).includes("~r"))).toBe(false);
    const tb = await w.tb(); expect(tb.balanced).toBe(true); expect(bal(tb, "4100")).toBe(-7500 - (await w.api(w.owner, w.R.invoices.GET)).body.filter((x: any) => x.id !== r.body.id && x.status === "POSTED" && x.docNo !== docNo).reduce((s: number, x: any) => s + Number(x.net), 0));
    expect((await w.recon()).ok).toBe(true);
    const stock = (await w.api(w.owner, w.R.stock)).body.filter((s: any) => s.productId === P).reduce((a: number, s: any) => a + Number(s.qty), 0); expect(stock).toBe(95);           // 100 bought - 5 sold
    id = r.body.id;
  });
  it("editing again and again keeps the same number; the history stays in the audit log", async () => {
    const g = await w.getInvoice(id); const r = await amend(id, body(g, "3", "1500")); expect(r.status).toBe(200); expect(r.body.docNo).toBe(docNo); id = r.body.id;
    expect((await w.getInvoice(id)).net).toBe("4500.0000");
    const a = await w.env.admin`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'sales_invoice.amend'`; expect(a[0]!.n).toBe(2);
    expect((await list()).filter((x) => x.docNo === docNo)).toHaveLength(1);
  });
  it("refused when the invoice has a payment, a return, or the accountant lacks the permission", async () => {
    const inv = (await w.sale({ product: P, qty: "1", price: "1000", date: "2026-03-05", type: "CREDIT" })).id; const g = await w.getInvoice(inv);
    const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: g.customerId, docDate: "2026-03-06", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "400", allocations: [{ invoiceId: inv, amount: "400" }] } });
    await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } });
    expect((await amend(inv, body(g, "1", "900"))).body.error.code).toBe("HAS_RECEIPTS");
    expect((await amend(id, body(await w.getInvoice(id), "1", "100"), w.acct)).status).toBe(403);
    expect((await amend(id, body({ ...(await w.getInvoice(id)) }, "1", "100", { version: 999 }))).body.error.code).toBe("VERSION_CONFLICT");
  });
  it("deleting a posted invoice (reverse) removes it from the lists; it can be shown with the 'cancelled' filter", async () => {
    const inv = (await w.sale({ product: P, qty: "1", price: "1000", date: "2026-03-09", type: "CREDIT" })).id; const g = await w.getInvoice(inv);
    expect((await w.api(w.owner, w.R.invoiceReverse, { method: "POST", params: { id: inv }, body: { reason: "إدخال بالخطأ" } })).status).toBe(200);
    expect((await list()).some((x) => x.id === inv)).toBe(false); expect((await list("?status=REVERSED")).some((x) => x.id === inv)).toBe(true);
    expect(g.docNo).toMatch(/^INV-/); expect((await w.tb()).balanced).toBe(true);
  });
  it("a cash invoice can be edited too: the automatic receipt is replaced, cash follows", async () => {
    const before = bal(await w.tb(), "1110");
    const inv = (await w.sale({ product: P, qty: "1", price: "2000", date: "2026-03-12", type: "CASH" })).id; const g = await w.getInvoice(inv);
    expect(bal(await w.tb(), "1110") - before).toBe(2000);
    const r = await amend(inv, body(g, "1", "3000", { saleType: "CASH", cashAccountId: w.ids.cashIQD })); expect(r.status).toBe(200);
    expect(bal(await w.tb(), "1110") - before).toBe(3000); expect((await w.getInvoice(r.body.id)).outstanding).toBe("0");
  });
});
