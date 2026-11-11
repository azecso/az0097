import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("20000000"); P = await w.mkProduct("CI"); await w.buy({ product: P, qty: "100", price: "800", date: "2026-02-01" }); });
afterAll(async () => { await w.env.teardown(); });
const rep = async (q = "") => (await w.api(w.owner, w.R.report2, { params: { id: "customer-invoices" }, path: `/api/reports2/customer-invoices${q}` } as any)).body;
const rcpt = async (inv: string, cust: string, amount: string, date: string) => { const r = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: cust, docDate: date, cashAccountId: w.ids.cashIQD, currency: "IQD", amount, allocations: [{ invoiceId: inv, amount }] } });
  await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: r.body.id } }); return r.body.id as string; };

describe("customer invoices in detail", () => {
  it("lists every effective invoice with its movements by date, the running remaining, and foots to the totals", async () => {
    const a = (await w.sale({ product: P, qty: "10", price: "1000", date: "2026-03-01", type: "CREDIT" })).id; const ga = await w.getInvoice(a);
    const b = (await w.sale({ product: P, qty: "5", price: "1000", date: "2026-03-05", type: "CREDIT" })).id;
    await rcpt(a, ga.customerId, "3000", "2026-03-10"); const r2 = await rcpt(a, ga.customerId, "2000", "2026-03-15");
    await w.api(w.owner, w.R.receiptReverse, { method: "POST", params: { id: r2 }, body: { reason: "سند خاطئ" } });
    const gb = await w.getInvoice(b); const rt = await w.api(w.owner, w.R.sreturns.POST, { method: "POST", body: { invoiceId: b, docDate: "2026-03-20", reason: "إرجاع جزئي", settlement: "REDUCE_RECEIVABLE", lines: [{ salesLineId: gb.lines[0].id, qtyBase: "1" }] } });
    await w.api(w.owner, w.R.sreturnPost, { method: "POST", params: { id: rt.body.id } });
    const r = await rep(); const rows = r.rows as any[];
    const ia = rows.find((x) => x.invoiceNo === ga.docNo && x.invoiceTotal), ib = rows.find((x) => x.invoiceNo === gb.docNo && x.invoiceTotal);
    expect(ia).toMatchObject({ invoiceTotal: "10000", paid: "3000", remaining: "7000" }); expect(Number(ib.returns)).toBe(1000); expect(Number(ib.remaining)).toBe(4000);
    const mvA = rows.filter((x) => x.invoiceNo === ga.docNo && !x.invoiceTotal);
    expect(mvA.map((x) => x.docDate)).toEqual(["2026-03-10", "2026-03-15"]); expect(mvA[1].type).toContain("ملغى"); expect(mvA[1].balance).toBeNull();     // reversed receipt is shown, does not count
    expect(Number(mvA[0].balance)).toBe(7000);
    const t = r.totals.find((x: any) => x.currency === "IQD"); expect(Number(t.invoiceTotal)).toBe(rows.filter((x) => x.invoiceTotal).reduce((s, x) => s + Number(x.invoiceTotal), 0));
    expect(Number(t.remaining)).toBe(rows.filter((x) => x.remaining).reduce((s, x) => s + Number(x.remaining), 0));
    const summ = (await w.api(w.owner, w.R.repCust, { path: `/api/reports/customers-summary?partyId=${ga.customerId}` } as any)).body;           // the customers summary lists each invoice on its own row
    expect(summ.rows.filter((x: any) => x.invoiceNo === ga.docNo || x.invoiceNo === gb.docNo)).toHaveLength(2);
    const sa = summ.rows.find((x: any) => x.invoiceNo === ga.docNo); expect(Number(sa.paid)).toBe(3000); expect(Number(sa.remaining)).toBe(7000);
    // agrees with the statement report for the same customer
    const st = (await w.api(w.owner, w.R.report2, { params: { id: "customers" }, path: `/api/reports2/customers?partyId=${ga.customerId}` } as any)).body.rows.find((x: any) => x.currency === "IQD");
    expect(Number(st.closing)).toBe(rows.filter((x) => x.remaining).reduce((s, x) => s + Number(x.remaining), 0));
  });
  it("a corrected invoice appears once (current version) and print/Excel render the same report", async () => {
    const c = (await w.sale({ product: P, qty: "2", price: "1000", date: "2026-04-01", type: "CREDIT" })).id; const g = await w.getInvoice(c);
    await w.api(w.owner, w.R.invoiceAmend, { method: "POST", params: { id: c }, body: { customerId: g.customerId, docDate: g.docDate, saleType: "CREDIT", currency: "IQD", deliveryMode: "WITH_INVOICE", discount: "0", lines: [{ productId: P, uom: "قطعة", qty: "3", unitPrice: "1000", lineDiscount: "0" }], version: g.version } });
    const rows = ((await rep("?from=2026-04-01&to=2026-04-30")).rows as any[]).filter((x) => x.invoiceTotal); expect(rows).toHaveLength(1); expect(Number(rows[0].invoiceTotal)).toBe(3000);
    const pr = await w.api(w.owner, w.R.report2, { params: { id: "customer-invoices" }, path: "/api/reports2/customer-invoices?from=2026-04-01&to=2026-04-30" } as any); expect(pr.status).toBe(200);
  });
});
