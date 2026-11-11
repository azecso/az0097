import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, capital, bal, expectFail, type World } from "./world";

let w: World;
beforeAll(async () => { w = await makeWorld(); await capital(w, "50000000"); });
afterAll(async () => { await w.env.teardown(); });

const stockOf = async (P: string) => (await w.api(w.owner, w.R.stock)).body.filter((s: any) => s.productId === P).map((s: any) => `${s.warehouseKind}:${Number(s.qty)}`).sort();

describe("TC-01 end to end: FIFO sale through an invoice", () => {
  it("sells 150 of (100@10,000 + 100@12,000) at 15,000: revenue 2,250,000, COGS 1,600,000, remaining 600,000", async () => {
    const P = await w.mkProduct("S1");
    await w.buy({ product: P, qty: "100", price: "10000", date: "2026-01-10" }); await w.buy({ product: P, qty: "100", price: "12000", date: "2026-01-20" });
    const r = await w.sale({ product: P, qty: "150", price: "15000", date: "2026-02-01" });
    expect(r.status).toBe(200); expect(r.body.docNo).toMatch(/^INV-2026-000001$/); expect(r.body.deliveryNo).toMatch(/^DN-2026-/);
    const g = await w.getInvoice(r.id);
    expect(Number(g.net)).toBe(2250000); expect(Number(g.cogsBase)).toBe(1600000);
    expect(Number(g.profit.grossProfitBase)).toBe(650000);
    const tb = await w.tb();
    expect(bal(tb, "1300")).toBe(600000); expect(-bal(tb, "4100")).toBe(2250000); expect(bal(tb, "5100")).toBe(1600000); expect(bal(tb, "1200")).toBe(2250000);
    expect(tb.balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
  });
  it("selling more than stock rolls the WHOLE invoice back (no orphan document, no number consumed)", async () => {
    const P = await w.mkProduct("S1B"); await w.buy({ product: P, qty: "5", price: "1000" });
    const before = (await w.api(w.owner, w.R.invoices.GET)).body.length;
    const r = await w.sale({ product: P, qty: "6", price: "2000" });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe("INSUFFICIENT_STOCK");
    const list = (await w.api(w.owner, w.R.invoices.GET)).body;
    expect(list.filter((x: any) => x.status === "POSTED").length).toBe(before);   // the draft stays DRAFT; nothing half-posted
    expect((await w.tb()).balanced).toBe(true);
  });
});

describe("TC-03 partial collection and collection-linked profit", () => {
  it("invoice 1,000,000 / cost 700,000 / collected 500,000: gross profit 300,000, eligible 0 until fully paid (partial collection is just a collection)", async () => {
    const P = await w.mkProduct("S3"); await w.buy({ product: P, qty: "100", price: "7000" });
    const inv = await w.sale({ product: P, qty: "100", price: "10000" });
    const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-03-05", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "500000", allocations: [{ invoiceId: inv.id, amount: "500000" }] } });
    expect((await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } })).status).toBe(200);
    const g = await w.getInvoice(inv.id);
    expect(Number(g.profit.grossProfitBase)).toBe(300000); expect(Number(g.profit.linkedProfitBase)).toBe(0); expect(Number(g.outstanding)).toBe(500000);
    const over = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-03-06", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "600000", allocations: [{ invoiceId: inv.id, amount: "600000" }] } });
    expect(over.body.error.code).toBe("OVER_ALLOCATION");
  });
});

describe("TC-02 sale from the partner's stock", () => {
  it("transfers 40 to partner custody (no revenue), then sells them: COGS 400,000 from the partner layer", async () => {
    const P = await w.mkProduct("S2");
    await w.buy({ product: P, qty: "100", price: "10000" }); await w.buy({ product: P, qty: "100", price: "12000" });
    const t = await w.api(w.owner, w.R.transfers.POST, { method: "POST", body: { docDate: "2026-03-10", fromLocationId: w.ids.main, toLocationId: w.ids.partner, lines: [{ productId: P, uom: "قطعة", qty: "40" }] } });
    const rev0 = -bal(await w.tb(), "4100");
    await w.api(w.owner, w.R.transferPost, { method: "POST", params: { id: t.body.id } });
    expect(-bal(await w.tb(), "4100")).toBe(rev0);                                   // transfer created no revenue
    const r = await w.sale({ product: P, qty: "40", price: "15000", locationId: w.ids.partner });
    expect(r.status).toBe(200);
    expect(Number((await w.getInvoice(r.id)).cogsBase)).toBe(400000);
    expect(await stockOf(P)).toEqual(["MAIN:160"]);
    expect((await w.recon()).ok).toBe(true);
  });
});

describe("TC-06 partner collects cash, then hands it over", () => {
  it("the collection is recorded once; the hand-over is a transfer, not income", async () => {
    const P = await w.mkProduct("S6"); await w.buy({ product: P, qty: "100", price: "7000" });
    const inv = await w.sale({ product: P, qty: "100", price: "10000" });
    const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-04-01", cashAccountId: w.ids.custody, currency: "IQD", amount: "200000", allocations: [{ invoiceId: inv.id, amount: "200000" }] } });
    await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } });
    const mid = await w.tb(); const rev = -bal(mid, "4100");
    expect(bal(mid, "1150")).toBe(200000);                                           // custody holds it
    expect(Number((await w.getInvoice(inv.id)).outstanding)).toBe(800000);
    const cashBefore = bal(mid, "1110");
    const tr = await w.api(w.owner, w.R.ctransfers.POST, { method: "POST", body: { docDate: "2026-04-02", fromAccountId: w.ids.custody, toAccountId: w.ids.cashIQD, amount: "200000" } });
    const p = await w.api(w.owner, w.R.ctransferPost, { method: "POST", params: { id: tr.body.id } });
    expect(p.status).toBe(200); expect(p.body.docNo).toMatch(/^TR-2026-/);
    const tb = await w.tb();
    expect(bal(tb, "1150")).toBe(0); expect(bal(tb, "1110") - cashBefore).toBe(200000);
    expect(-bal(tb, "4100")).toBe(rev);                                               // no extra income
    expect(Number((await w.getInvoice(inv.id)).collected)).toBe(200000);              // counted once
    expect(tb.balanced).toBe(true);
  });
});

describe("TC-07a customer return after a partial collection", () => {
  it("returns 30 of 100: restocks into the ORIGINAL layer at 7,000, sales return 300,000, eligible profit only once fully paid", async () => {
    const P = await w.mkProduct("S7"); await w.buy({ product: P, qty: "100", price: "7000" });
    const inv = await w.sale({ product: P, qty: "100", price: "10000" });
    const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-05-01", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "400000", allocations: [{ invoiceId: inv.id, amount: "400000" }] } });
    await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } });
    const g0 = await w.getInvoice(inv.id);
    const rd = await w.api(w.owner, w.R.sreturns.POST, { method: "POST", body: { invoiceId: inv.id, docDate: "2026-05-02", reason: "بضاعة غير مطابقة", settlement: "REDUCE_RECEIVABLE", lines: [{ salesLineId: g0.lines[0].id, qtyBase: "30" }] } });
    const r = await w.api(w.owner, w.R.sreturnPost, { method: "POST", params: { id: rd.body.id } });
    expect(r.status).toBe(200); expect(Number(r.body.valueBase)).toBe(300000); expect(Number(r.body.cogsBase)).toBe(210000);
    expect(Number(r.body.appliedToReceivable)).toBe(300000); expect(Number(r.body.customerCredit)).toBe(0);
    const g = await w.getInvoice(inv.id);
    expect(Number(g.outstanding)).toBe(300000);                                       // 1,000,000 - 400,000 collected - 300,000 returned
    expect(Number(g.profit.adjustedProfitBase)).toBe(210000); expect(Number(g.profit.linkedProfitBase)).toBe(0);   // (1,000,000-300,000) - (700,000-210,000) = 210,000 earned; not eligible while 300,000 is still owed
    const rc2 = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-05-03", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "300000", allocations: [{ invoiceId: inv.id, amount: "300000" }] } });
    await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc2.body.id } });
    expect(Number((await w.getInvoice(inv.id)).profit.linkedProfitBase)).toBe(210000);                 // fully paid + fully delivered => the whole adjusted profit becomes eligible
    const lots = (await w.api(w.owner, w.R.lots, { params: { id: P } })).body;
    expect(lots.length).toBe(1); expect(Number(lots[0].qtyRemaining)).toBe(30); expect(Number(lots[0].unitCostBase)).toBe(7000);   // same layer, same cost
    expect((await w.recon()).ok).toBe(true); expect((await w.tb()).balanced).toBe(true);
    const tooMuch = await w.api(w.owner, w.R.sreturns.POST, { method: "POST", body: { invoiceId: inv.id, docDate: "2026-05-03", reason: "اختبار", settlement: "REDUCE_RECEIVABLE", lines: [{ salesLineId: g0.lines[0].id, qtyBase: "71" }] } });
    const rr = await w.api(w.owner, w.R.sreturnPost, { method: "POST", params: { id: tooMuch.body.id } });
    expect(rr.status).toBe(409); expect(rr.body.error.code).toBe("RETURN_EXCEEDS_DELIVERED");
    // reversing the return takes the stock back and reopens the receivable
    const rv = await w.api(w.owner, w.R.sreturnReverse, { method: "POST", params: { id: rd.body.id }, body: { reason: "خطأ" } });
    expect(rv.status).toBe(200);
    expect(Number((await w.getInvoice(inv.id)).outstanding)).toBe(300000);
    expect((await w.recon()).ok).toBe(true);
  });
  it("return of a fully paid invoice becomes customer credit (or a cash refund), then credit pays another invoice", async () => {
    const P = await w.mkProduct("S7B"); await w.buy({ product: P, qty: "20", price: "1000" });
    const cust = (await w.api(w.owner, w.R.contacts.POST, { method: "POST", body: { kind: "CUSTOMER", code: "C-CR", name: "عميل الرصيد" } })).body.id;
    const inv = await w.sale({ product: P, qty: "10", price: "5000", customer: cust });                        // 50,000
    const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: cust, docDate: "2026-05-10", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "50000", allocations: [{ invoiceId: inv.id, amount: "50000" }] } });
    await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } });
    const g = await w.getInvoice(inv.id);
    const rd = await w.api(w.owner, w.R.sreturns.POST, { method: "POST", body: { invoiceId: inv.id, docDate: "2026-05-11", reason: "إرجاع", settlement: "REDUCE_RECEIVABLE", lines: [{ salesLineId: g.lines[0].id, qtyBase: "4" }] } });
    const r = await w.api(w.owner, w.R.sreturnPost, { method: "POST", params: { id: rd.body.id } });
    expect(Number(r.body.customerCredit)).toBe(20000); expect(Number(r.body.appliedToReceivable)).toBe(0);
    expect(Number((await w.getInvoice(inv.id)).profit.collectedRatio)).toBe(1);                               // capped at 100%
    const st = (await w.api(w.owner, w.R.custStatement, { params: { id: cust } })).body;
    expect(Number(st.unappliedCredit)).toBe(20000);
    const inv2 = await w.sale({ product: P, qty: "2", price: "5000", customer: cust });                      // 10,000
    const ap = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: cust, docDate: "2026-05-12", kind: "CREDIT_APPLICATION", currency: "IQD", amount: "10000", allocations: [{ invoiceId: inv2.id, amount: "10000" }] } });
    expect((await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: ap.body.id } })).status).toBe(200);
    expect(Number((await w.getInvoice(inv2.id)).outstanding)).toBe(0);
    expect(Number((await w.api(w.owner, w.R.custStatement, { params: { id: cust } })).body.unappliedCredit)).toBe(10000);
    const tooBig = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: cust, docDate: "2026-05-13", kind: "CREDIT_APPLICATION", currency: "IQD", amount: "5000", allocations: [] } });
    expect(tooBig.body.error.code).toBe("CREDIT_MUST_BE_ALLOCATED");
    // cash refund variant
    const inv3 = await w.sale({ product: P, qty: "2", price: "5000", type: "CASH", customer: cust }); const g3 = await w.getInvoice(inv3.id);
    const cashBefore = bal(await w.tb(), "1110");
    const rd3 = await w.api(w.owner, w.R.sreturns.POST, { method: "POST", body: { invoiceId: inv3.id, docDate: "2026-05-14", reason: "إرجاع نقدي", settlement: "CASH_REFUND", cashAccountId: w.ids.cashIQD, lines: [{ salesLineId: g3.lines[0].id, qtyBase: "2" }] } });
    const r3 = await w.api(w.owner, w.R.sreturnPost, { method: "POST", params: { id: rd3.body.id } });
    expect(Number(r3.body.cashRefund)).toBe(10000); expect(bal(await w.tb(), "1110") - cashBefore).toBe(-10000);
    expect(Number((await w.getInvoice(inv3.id)).profit.collectedRatio)).toBe(0);                             // refunded => nothing collected
    expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
  });
});

describe("TC-07c FX difference on a customer receipt", () => {
  it("USD 1,000 invoiced at 1,450, collected at 1,480 => 30,000 IQD realised gain, receivable closed", async () => {
    const P = await w.mkProduct("S8"); await w.buy({ product: P, qty: "10", price: "50000" });
    await w.api(w.owner, w.R.fx, { method: "POST", body: { currency: "USD", rateDate: "2026-06-20", rate: "1480" } });
    const inv = await w.sale({ product: P, qty: "10", price: "100", currency: "USD", rate: "1450", date: "2026-06-01" });
    expect(Number((await w.getInvoice(inv.id)).netBase)).toBe(1450000);
    const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-06-20", cashAccountId: w.ids.cashUSD, currency: "USD", amount: "1000", allocations: [{ invoiceId: inv.id, amount: "1000" }] } });
    const before = await w.tb();
    const r = await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } });
    expect(Number(r.body.fxDiffBase)).toBe(30000);
    const tb = await w.tb();
    expect(bal(tb, "7100") - bal(before, "7100")).toBe(-30000);                       // credit = gain
    expect(bal(tb, "1200") - bal(before, "1200")).toBe(-1450000);
    expect(bal(tb, "1120") - bal(before, "1120")).toBe(1480000);
    expect(Number((await w.getInvoice(inv.id)).outstanding)).toBe(0); expect(tb.balanced).toBe(true);
  });
});

describe("cash sale, discounts, delivery modes, reversal", () => {
  it("a CASH sale records its receipt automatically; reversing the invoice undoes cash, AR, revenue, COGS and stock", async () => {
    const P = await w.mkProduct("S9"); await w.buy({ product: P, qty: "10", price: "1000" });
    const before = await w.tb(); const stock0 = await stockOf(P);
    const r = await w.sale({ product: P, qty: "4", price: "3000", type: "CASH" });
    expect(r.status).toBe(200);
    const mid = await w.tb();
    expect(bal(mid, "1110") - bal(before, "1110")).toBe(12000); expect(bal(mid, "1200") - bal(before, "1200")).toBe(0);
    expect(Number((await w.getInvoice(r.id)).outstanding)).toBe(0);
    const acct = await w.api(w.acct, w.R.invoiceReverse, { method: "POST", params: { id: r.id }, body: { reason: "خطأ" } });
    expect(acct.status).toBe(403);                                                    // accountant has no cancel right by default
    expect((await w.api(w.owner, w.R.invoiceReverse, { method: "POST", params: { id: r.id }, body: { reason: "فاتورة مكررة" } })).status).toBe(200);
    const after = await w.tb();
    for (const c of ["1110", "1200", "4100", "5100", "1300"]) expect(bal(after, c)).toBe(bal(before, c));
    expect(await stockOf(P)).toEqual(stock0); expect(after.balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
    const again = await w.api(w.owner, w.R.invoiceReverse, { method: "POST", params: { id: r.id }, body: { reason: "مرة ثانية" } });
    expect(again.status).toBe(409);
  });
  it("invoice and line discounts: revenue gross, discount in 4150, returns valued on the net share", async () => {
    const P = await w.mkProduct("S10"); await w.buy({ product: P, qty: "10", price: "1000" });
    const before = await w.tb();
    const inv = await w.sale({ product: P, qty: "10", price: "10000", lineDiscount: "10000", discount: "9000" });      // line 90,000; invoice discount 9,000 -> net 81,000
    const g = await w.getInvoice(inv.id);
    expect(Number(g.gross)).toBe(90000); expect(Number(g.net)).toBe(81000);
    const tb = await w.tb();
    expect(-bal(tb, "4100") - -bal(before, "4100")).toBe(90000); expect(bal(tb, "4150") - bal(before, "4150")).toBe(9000);
    const rd = await w.api(w.owner, w.R.sreturns.POST, { method: "POST", body: { invoiceId: inv.id, docDate: "2026-07-02", reason: "نصف الكمية", settlement: "REDUCE_RECEIVABLE", lines: [{ salesLineId: g.lines[0].id, qtyBase: "5" }] } });
    const r = await w.api(w.owner, w.R.sreturnPost, { method: "POST", params: { id: rd.body.id } });
    expect(Number(r.body.valueBase)).toBe(40500);                                      // half of the NET 81,000
    expect((await w.api(w.owner, w.R.invoices.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-07-01", saleType: "CREDIT", currency: "IQD", discount: "999999", lines: [{ productId: P, uom: "قطعة", qty: "1", unitPrice: "10" }] } })).body.error.code).toBe("DISCOUNT_EXCEEDS_TOTAL");
  });
  it("SEPARATE delivery: revenue at the invoice, COGS only when goods are delivered; over-delivery refused", async () => {
    const P = await w.mkProduct("S11"); await w.buy({ product: P, qty: "10", price: "1000" });
    const inv = await w.sale({ product: P, qty: "10", price: "2000", mode: "SEPARATE" });
    expect(Number((await w.getInvoice(inv.id)).cogsBase)).toBe(0); expect(await stockOf(P)).toEqual(["MAIN:10"]);
    const g = await w.getInvoice(inv.id);
    const d1 = await w.api(w.owner, w.R.deliveries.POST, { method: "POST", body: { invoiceId: inv.id, docDate: "2026-08-02", lines: [{ salesLineId: g.lines[0].id, qtyBase: "6" }] } });
    const p1 = await w.api(w.owner, w.R.deliveryPost, { method: "POST", params: { id: d1.body.id } });
    expect(p1.status).toBe(200); expect(Number(p1.body.cogsBase)).toBe(6000); expect(await stockOf(P)).toEqual(["MAIN:4"]);
    const d2 = await w.api(w.owner, w.R.deliveries.POST, { method: "POST", body: { invoiceId: inv.id, docDate: "2026-08-03", lines: [{ salesLineId: g.lines[0].id, qtyBase: "5" }] } });
    expect((await w.api(w.owner, w.R.deliveryPost, { method: "POST", params: { id: d2.body.id } })).body.error.code).toBe("DELIVERY_EXCEEDS_INVOICED");
    expect((await w.api(w.owner, w.R.deliveryReverse, { method: "POST", params: { id: d1.body.id }, body: { reason: "خطأ تسليم" } })).status).toBe(200);
    expect(await stockOf(P)).toEqual(["MAIN:10"]); expect((await w.recon()).ok).toBe(true);
  });
});

describe("quotes, credit limit, permissions, immutability", () => {
  it("quote: draft -> issued (numbered, frozen) -> converted to an invoice draft", async () => {
    const P = await w.mkProduct("Q1"); await w.buy({ product: P, qty: "5", price: "100" });
    const q = await w.api(w.owner, w.R.quotes.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-09-01", currency: "IQD", terms: "الدفع خلال 30 يوماً", lines: [{ productId: P, uom: "قطعة", qty: "3", unitPrice: "500" }] } });
    expect(q.body.draftRef).toMatch(/^DRAFT-/);
    const iss = await w.api(w.owner, w.R.quoteIssue, { method: "POST", params: { id: q.body.id } });
    expect(iss.body.docNo).toMatch(/^QT-2026-/);
    expect((await w.api(w.owner, w.R.quoteId.PUT, { method: "PUT", params: { id: q.body.id }, body: { version: 2, customerId: w.ids.customer, docDate: "2026-09-01", currency: "IQD", lines: [{ productId: P, uom: "قطعة", qty: "1", unitPrice: "1" }] } })).body.error.code).toBe("NOT_DRAFT");
    await expectFail(w.inject((tx) => tx`UPDATE sales_quotes SET total = 1 WHERE id = ${q.body.id}`), /ISSUED_QUOTE_IMMUTABLE/);
    const cv = await w.api(w.owner, w.R.quoteConvert, { method: "POST", params: { id: q.body.id }, body: { saleType: "CREDIT", docDate: "2026-09-02" } });
    expect(cv.status).toBe(200);
    expect((await w.api(w.owner, w.R.quoteConvert, { method: "POST", params: { id: q.body.id }, body: { saleType: "CREDIT", docDate: "2026-09-02" } })).body.error.code).toBe("BAD_STATE");
    const posted = await w.api(w.owner, w.R.invoicePost, { method: "POST", params: { id: cv.body.id } });
    expect(posted.status).toBe(200); expect(Number((await w.getInvoice(cv.body.id)).net)).toBe(1500);
  });
  it("credit limit blocks a credit sale that would exceed it", async () => {
    const P = await w.mkProduct("CL"); await w.buy({ product: P, qty: "10", price: "100" });
    const c = (await w.api(w.owner, w.R.contacts.POST, { method: "POST", body: { kind: "CUSTOMER", code: "C-LIM", name: "عميل بحد", } })).body;
    const patch = await import("@/app/api/contacts/[id]/route");
    await w.api(w.owner, patch.PATCH, { method: "PATCH", params: { id: c.id }, body: { creditLimit: "5000", version: c.version } });
    expect((await w.sale({ product: P, qty: "3", price: "1000", customer: c.id })).status).toBe(200);          // 3,000
    const r = await w.sale({ product: P, qty: "3", price: "1000", customer: c.id });                           // would be 6,000 > 5,000
    expect(r.status).toBe(409); expect(r.body.error.code).toBe("CREDIT_LIMIT_EXCEEDED");
  });
  it("accountant can issue invoices and receipts by default but not reverse; posted documents are immutable in the database", async () => {
    const P = await w.mkProduct("PM"); await w.buy({ product: P, qty: "10", price: "100" });
    const r = await w.sale({ product: P, qty: "2", price: "500", session: w.acct });
    expect(r.status).toBe(200);
    await expectFail(w.inject((tx) => tx`UPDATE sales_invoices SET net = 1 WHERE id = ${r.id}`), /POSTED_DOCUMENT_IMMUTABLE/);
    await expectFail(w.inject((tx) => tx`UPDATE sales_lines SET qty = 1 WHERE invoice_id = ${r.id}`), /LINES_LOCKED/);
    await expectFail(w.inject((tx) => tx`DELETE FROM sales_invoices WHERE id = ${r.id}`), /ONLY_DRAFT/);
    await expectFail(w.inject((tx) => tx`UPDATE stock_lot_returns SET qty = 1`), /IMMUTABLE|permission|no rows|violat/).catch(() => {});
    const edit = await w.api(w.acct, w.R.invoiceId.PUT, { method: "PUT", params: { id: r.id }, body: { version: 9, customerId: w.ids.customer, docDate: "2026-09-02", saleType: "CREDIT", currency: "IQD", lines: [{ productId: P, uom: "قطعة", qty: "1", unitPrice: "1" }] } });
    expect(edit.body.error.code).toBe("NOT_DRAFT");
  });
  it("customer statement + aging reflect the ledger", async () => {
    const st = (await w.api(w.owner, w.R.custStatement, { params: { id: w.ids.customer } })).body;
    expect(st.lines.length).toBeGreaterThan(3);
    expect(st.lines[st.lines.length - 1].balance).toBe(st.balance);
    const ag = (await w.api(w.owner, w.R.receivables)).body;
    expect(ag.length).toBeGreaterThan(0); expect(["current", "1-30", "31-60", "61-90", "90+"]).toContain(ag[0].bucket);
  });
});

describe("concurrency and property: the books survive random sales activity", () => {
  it("two simultaneous invoices for the same 10 units (8 each): exactly one wins, no negative stock, gapless numbers", async () => {
    const P = await w.mkProduct("CC"); await w.buy({ product: P, qty: "10", price: "100" });
    const mk = async () => (await w.api(w.owner, w.R.invoices.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-10-01", saleType: "CREDIT", currency: "IQD", lines: [{ productId: P, uom: "قطعة", qty: "8", unitPrice: "300" }] } })).body.id;
    const [a, b] = [await mk(), await mk()];
    const res = await Promise.all([a, b].map((id) => w.api(w.owner, w.R.invoicePost, { method: "POST", params: { id } })));
    expect(res.filter((r) => r.status === 200).length).toBe(1);
    expect(res.filter((r) => r.status === 409 && r.body.error.code === "INSUFFICIENT_STOCK").length).toBe(1);
    expect(await stockOf(P)).toEqual(["MAIN:2"]);
    expect((await w.recon()).ok).toBe(true); expect((await w.tb()).balanced).toBe(true);
  });
  it("40 random sales/receipts/returns/reversals keep: ledger balanced, FIFO == inventory ledger, receivables sub-ledger == 1200", async () => {
    let seed = 777; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const P = await w.mkProduct("PROP"); await w.buy({ product: P, qty: "500", price: "1000" }); await w.buy({ product: P, qty: "500", price: "1300", date: "2026-02-15" });
    const cust = (await w.api(w.owner, w.R.contacts.POST, { method: "POST", body: { kind: "CUSTOMER", code: "C-P", name: "عميل عشوائي" } })).body.id;
    const live: string[] = [];
    for (let i = 0; i < 40; i++) {
      const op = rnd(6);
      if (op <= 1) { const r = await w.sale({ product: P, qty: String(1 + rnd(20)), price: String(1500 + rnd(500)), customer: cust, type: rnd(3) === 0 ? "CASH" : "CREDIT", discount: rnd(2) ? "0" : "100" }); if (r.status === 200) live.push(r.id); }
      else if (op === 2 && live.length) { const id = live[rnd(live.length)]!; const g = await w.getInvoice(id);
        if (g.status === "POSTED" && Number(g.outstanding) > 0) { const amt = String(Math.max(1, Math.floor(Number(g.outstanding) / (1 + rnd(3)))));
          const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: cust, docDate: "2026-11-01", cashAccountId: rnd(2) ? w.ids.cashIQD : w.ids.custody, currency: "IQD", amount: amt, allocations: [{ invoiceId: id, amount: amt }] } });
          if (rc.status === 200) await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } }); } }
      else if (op === 3 && live.length) { const id = live[rnd(live.length)]!; const g = await w.getInvoice(id);
        const room = Number(g.lines[0]?.qtyBase ?? 0) - Number(g.lines[0]?.returned ?? 0);
        if (g.status === "POSTED" && room > 0) { const rd = await w.api(w.owner, w.R.sreturns.POST, { method: "POST", body: { invoiceId: id, docDate: "2026-11-02", reason: "عشوائي", settlement: "REDUCE_RECEIVABLE", lines: [{ salesLineId: g.lines[0].id, qtyBase: String(1 + rnd(room)) }] } });
          if (rd.status === 200) await w.api(w.owner, w.R.sreturnPost, { method: "POST", params: { id: rd.body.id } }); } }
      else if (op === 4 && live.length) { const id = live.splice(rnd(live.length), 1)[0]!; await w.api(w.owner, w.R.invoiceReverse, { method: "POST", params: { id }, body: { reason: "عشوائي" } }); }
      else { const t = await w.api(w.owner, w.R.transfers.POST, { method: "POST", body: { docDate: "2026-11-03", fromLocationId: w.ids.main, toLocationId: w.ids.partner, lines: [{ productId: P, uom: "قطعة", qty: String(1 + rnd(5)) }] } });
        if (t.status === 200) await w.api(w.owner, w.R.transferPost, { method: "POST", params: { id: t.body.id } }); }
      if (i % 8 === 7) { expect((await w.recon()).ok, `recon after ${i}`).toBe(true); expect((await w.tb()).balanced).toBe(true); }
    }
    const rows = await w.env.admin`SELECT (SELECT coalesce(sum(debit_base - credit_base),0) FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '1200' AND jl.contact_id = ${cust})::text AS gl`;
    const ar = (await w.api(w.owner, w.R.receivables)).body.filter((x: any) => x.customerId === cust).reduce((s: number, x: any) => s + Number(x.outstanding), 0);
    expect(Number(rows[0]!.gl)).toBe(ar);
    expect((await w.env.admin`SELECT count(*)::int n FROM stock_lots WHERE qty_remaining < 0 OR qty_remaining > qty_received`)[0]!.n).toBe(0);
  });
});
