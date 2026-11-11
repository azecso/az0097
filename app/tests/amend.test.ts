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
  it("an invoice WITH a receipt can be edited: the receipt follows it with the same number; refused for returns, no permission, stale version, or a total below what was collected", async () => {
    const inv = (await w.sale({ product: P, qty: "1", price: "1000", date: "2026-03-05", type: "CREDIT" })).id; const g = await w.getInvoice(inv);
    const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: g.customerId, docDate: "2026-03-06", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "400", allocations: [{ invoiceId: inv, amount: "400" }] } });
    await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } });
    const rno = (await w.api(w.owner, w.R.receiptId.GET, { params: { id: rc.body.id } })).body.docNo;
    expect((await amend(inv, body(g, "1", "300"))).body.error.code).toBe("RECEIPT_EXCEEDS_NEW_TOTAL");     // 300 < 400 collected: nothing changes
    expect((await w.getInvoice(inv)).status).toBe("POSTED");
    const ok = await amend(inv, body(g, "2", "1000")); expect(ok.status).toBe(200);
    const ng = await w.getInvoice(ok.body.id); expect(ng).toMatchObject({ docNo: g.docNo, net: "2000.0000", collected: "400.0000", outstanding: "1600" });
    const after = (await w.api(w.owner, w.R.receiptId.GET, { params: { id: rc.body.id } })).body; expect(after).toMatchObject({ docNo: rno, status: "POSTED" }); expect((await w.tb()).balanced).toBe(true);
    expect((await amend(ok.body.id, body(await w.getInvoice(ok.body.id), "1", "100"), w.acct)).status).toBe(403);
    expect((await amend(ok.body.id, body({ ...(await w.getInvoice(ok.body.id)) }, "1", "100", { version: 999 }))).body.error.code).toBe("VERSION_CONFLICT");
    id = ok.body.id;
  });
  it("deleting an invoice that has a receipt: refused, then allowed with 'cascade' (the receipt is deleted with it, cash goes back)", async () => {
    const before = bal(await w.tb(), "1110");
    expect((await w.api(w.owner, w.R.invoiceReverse, { method: "POST", params: { id }, body: { reason: "حذف" } })).body.error.code).toBe("HAS_RECEIPTS");
    expect((await w.api(w.owner, w.R.invoiceReverse, { method: "POST", params: { id }, body: { reason: "حذف", cascade: true } })).status).toBe(200);
    expect(bal(await w.tb(), "1110") - before).toBe(-400); expect((await list()).some((x) => x.id === id)).toBe(false); expect((await w.tb()).balanced).toBe(true);
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

describe("editing a posted receipt keeps its number", () => {
  it("800 -> 700: same number, cash follows, invoice outstanding follows; automatic cash-sale receipts are edited through the invoice", async () => {
    const inv = (await w.sale({ product: P, qty: "1", price: "1000", date: "2026-04-01", type: "CREDIT" })).id; const g = await w.getInvoice(inv);
    const mk = (amount: string) => ({ customerId: g.customerId, docDate: "2026-04-02", kind: "CASH", cashAccountId: w.ids.cashIQD, currency: "IQD", amount, allocations: [{ invoiceId: inv, amount }] });
    const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: mk("800") }); await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } });
    const cur = (await w.api(w.owner, w.R.receiptId.GET, { params: { id: rc.body.id } })).body; const cash0 = bal(await w.tb(), "1110");
    const edit = await w.api(w.owner, w.R.receiptAmend, { method: "POST", params: { id: rc.body.id }, body: { ...mk("700"), version: (await w.api(w.owner, w.R.receiptEdit, { params: { id: rc.body.id } })).body.version } });
    expect(edit.status).toBe(200); expect(edit.body.docNo).toBe(cur.docNo);
    expect(bal(await w.tb(), "1110") - cash0).toBe(-100); expect((await w.getInvoice(inv)).outstanding).toBe("300"); expect((await w.tb()).balanced).toBe(true);
    const form = (await w.api(w.owner, w.R.receiptEdit, { params: { id: rc.body.id } })).body; expect(form.allocations[0]).toMatchObject({ docNo: g.docNo, cash: "700.0000", outstandingWithout: "1000" });
    const auto = (await w.api(w.owner, w.R.receipts.GET)).body.find((x: any) => x.autoForInvoice); if (auto) expect((await w.api(w.owner, w.R.receiptAmend, { method: "POST", params: { id: auto.id }, body: { ...mk("1"), version: 1 } })).body.error.code).toBe("AUTO_RECEIPT");
    expect((await w.api(w.acct, w.R.receiptAmend, { method: "POST", params: { id: rc.body.id }, body: { ...mk("600"), version: 99 } })).status).toBe(403);
    expect((await w.api(w.owner, w.R.receiptAmend, { method: "POST", params: { id: rc.body.id }, body: { ...mk("600"), version: 1 } })).body.error.code).toBe("VERSION_CONFLICT");
  });
});

describe("document version history", () => {
  it("shows the whole chain of edited invoice versions (original, hidden replaced ones, current) and who did what", async () => {
    const inv = await w.sale({ product: P, qty: "2", price: "1000", date: "2026-04-01", type: "CREDIT" }); let id = inv.id;
    const g = await w.getInvoice(id); const r1 = await amend(id, body(g, "3", "1000")); expect(r1.status).toBe(200); id = r1.body.id;
    const g2 = await w.getInvoice(id); const r2 = await amend(id, body(g2, "4", "1000")); expect(r2.status).toBe(200);
    const hist = await import("@/app/api/document-history/[kind]/[id]/route");
    const h = (await w.api(w.owner, hist.GET, { params: { kind: "sales-invoices", id: r2.body.id } })).body;
    expect(h.chain).toHaveLength(3); expect(h.chain.filter((c: any) => c.replaced)).toHaveLength(2); expect(h.chain[2].amendedFrom).toBe(h.chain[1].id);
    expect(h.events.filter((e: any) => e.action === "sales_invoice.amend")).toHaveLength(2); expect(h.events.every((e: any) => e.user)).toBe(true);
    expect((await w.api(w.owner, hist.GET, { params: { kind: "nope", id: r2.body.id } })).status).toBe(400);
  });
});
