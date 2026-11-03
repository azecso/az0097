import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, capital, bal, expectFail, sell, type World } from "./world";

let w: World;
beforeAll(async () => { w = await makeWorld(); await capital(w); });
afterAll(async () => { await w.env.teardown(); });

describe("TC-01  capital + FIFO purchases", () => {
  let P: string;
  it("buys 100 @10,000 (cash) then 100 @12,000 (credit); FIFO sale of 150 => COGS 1,600,000, remaining 50 x 12,000", async () => {
    P = await w.mkProduct("TC01");
    const a = await w.buy({ product: P, qty: "100", price: "10000", date: "2026-02-01", type: "CASH" });
    const b = await w.buy({ product: P, qty: "100", price: "12000", date: "2026-02-10", type: "CREDIT" });
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(a.body.docNo).toMatch(/^PO-2026-000001$/); expect(b.body.docNo).toMatch(/^PO-2026-000002$/);
    let tb = await w.tb();
    expect(bal(tb, "1300")).toBe(2200000);                  // purchases are inventory, NOT an expense
    expect(bal(tb, "1110")).toBe(10000000 - 1000000);       // cash purchase reduced cash
    expect(-bal(tb, "2100")).toBe(1200000);                 // credit purchase = supplier payable
    expect(tb.rows.some((r: any) => r.type === "EXPENSE")).toBe(false);
    const cogs = await w.inject(async (tx, actor, l) => {
      const docId = crypto.randomUUID();
      const out = await l.consumeFifo(tx, actor.companyId, { productId: P, locationId: w.ids.main, qtyBase: "150", type: "SALE_OUT", docType: "test_sale", docId, docLineId: crypto.randomUUID(), at: new Date() });
      await l.postJournal(tx, actor, { date: "2026-02-15", sourceDocType: "test_sale", sourceDocId: docId, lines: [{ account: "5100", debit: out.cost }, { account: "1300", credit: out.cost }] });
      return out.cost.toString();
    });
    expect(cogs).toBe("1600000");
    tb = await w.tb();
    expect(bal(tb, "1300")).toBe(600000);                   // 50 x 12,000
    expect(tb.balanced).toBe(true);
    expect((await w.recon()).ok).toBe(true);
  });
  it("selling more than the remaining stock is rejected and nothing is written", async () => {
    await expectFail(w.inject((tx, actor, l) => l.consumeFifo(tx, actor.companyId, { productId: P, locationId: w.ids.main, qtyBase: "51", type: "SALE_OUT", docType: "x", docId: crypto.randomUUID(), docLineId: crypto.randomUUID(), at: new Date() })), /INSUFFICIENT_STOCK/);
    expect((await w.recon()).main.lots).toBe("600000");
  });
});

describe("TC-02  transfer to partner custody", () => {
  let P: string, T1: string;
  it("moves 40 pieces: no revenue/COGS, layers keep cost and original receipt date", async () => {
    P = await w.mkProduct("TC02");
    await w.buy({ product: P, qty: "100", price: "10000", date: "2026-03-01" }); await w.buy({ product: P, qty: "100", price: "12000", date: "2026-03-05" });
    const d = await w.api(w.owner, w.R.transfers.POST, { method: "POST", body: { docDate: "2026-03-10", fromLocationId: w.ids.main, toLocationId: w.ids.partner, lines: [{ productId: P, uom: "قطعة", qty: "40" }] } });
    expect(d.status).toBe(200); T1 = d.body.id;
    const before = await w.tb();
    const r = await w.api(w.owner, w.R.transferPost, { method: "POST", params: { id: T1 } });
    expect(r.status).toBe(200); expect(r.body.costBase).toBe("400000");
    const tb = await w.tb();
    expect(bal(tb, "1310") - bal(before, "1310")).toBe(400000);
    expect(bal(tb, "1300") - bal(before, "1300")).toBe(-400000);
    expect(bal(tb, "5100")).toBe(1600000);                          // unchanged from TC-01: transfer created no COGS
    expect(tb.rows.filter((x: any) => x.type === "REVENUE").length).toBe(0);
    const lots = (await w.api(w.owner, w.R.lots, { params: { id: P } })).body;
    const partnerLot = lots.find((l: any) => l.location === "عهدة الشريك");
    expect(partnerLot.qtyRemaining).toBe("40.000000"); expect(partnerLot.unitCostBase).toBe("10000.0000"); expect(partnerLot.sourceLotId).toBeTruthy();
    expect(lots.find((l: any) => l.id === partnerLot.sourceLotId).receivedAt).toBe(partnerLot.receivedAt);
    const main = lots.filter((l: any) => l.location === "الرئيسي" && l.qtyRemaining !== "0.000000").map((l: any) => `${Number(l.qtyRemaining)}x${Number(l.unitCostBase)}`);
    expect(main).toEqual(["60x10000", "100x12000"]);
    expect((await w.recon()).ok).toBe(true);
  });
  it("selling the transferred goods consumes the partner layer: COGS 400,000", async () => {
    expect(await sell(w, P, w.ids.partner, "40")).toBe("400000");
    expect((await w.recon()).ok).toBe(true);
  });
  it("cannot reverse a transfer whose goods were sold; a fresh transfer CAN be reversed exactly", async () => {
    const r = await w.api(w.owner, w.R.transferReverse, { method: "POST", params: { id: T1 }, body: { reason: "اختبار" } });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe("TRANSFERRED_STOCK_MOVED");
    const d = await w.api(w.owner, w.R.transfers.POST, { method: "POST", body: { docDate: "2026-03-11", fromLocationId: w.ids.main, toLocationId: w.ids.partner, lines: [{ productId: P, uom: "قطعة", qty: "10" }] } });
    await w.api(w.owner, w.R.transferPost, { method: "POST", params: { id: d.body.id } });
    const before = await w.recon();
    const rv = await w.api(w.owner, w.R.transferReverse, { method: "POST", params: { id: d.body.id }, body: { reason: "خطأ إدخال" } });
    expect(rv.status).toBe(200);
    const after = await w.recon();
    expect(after.ok).toBe(true); expect(after.main.lots).not.toBe(before.main.lots);
    expect((await w.tb()).balanced).toBe(true);
  });
  it("transfer without enough stock fails with INSUFFICIENT_STOCK", async () => {
    const d = await w.api(w.owner, w.R.transfers.POST, { method: "POST", body: { docDate: "2026-03-12", fromLocationId: w.ids.partner, toLocationId: w.ids.main, lines: [{ productId: P, uom: "قطعة", qty: "5" }] } });
    const r = await w.api(w.owner, w.R.transferPost, { method: "POST", params: { id: d.body.id } });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe("INSUFFICIENT_STOCK");
  });
});

describe("purchase document lifecycle", () => {
  let P: string, id: string;
  it("draft is editable/deletable; posting assigns a gapless number; posted is immutable at API and DB level", async () => {
    P = await w.mkProduct("LIFE");
    const c = await w.api(w.owner, w.R.purchases.POST, { method: "POST", body: { supplierId: w.ids.supplier, docDate: "2026-04-01", paymentType: "CREDIT", currency: "IQD", supplierInvoiceNo: "INV-77", lines: [{ productId: P, uom: "قطعة", qty: "10", unitPrice: "500" }] } });
    id = c.body.id; expect(c.body.draftRef).toMatch(/^DRAFT-/);
    const upd = await w.api(w.owner, w.R.purchaseId.PUT, { method: "PUT", params: { id }, body: { version: c.body.version, supplierId: w.ids.supplier, docDate: "2026-04-01", paymentType: "CREDIT", currency: "IQD", supplierInvoiceNo: "INV-77", lines: [{ productId: P, uom: "قطعة", qty: "20", unitPrice: "500" }] } });
    expect(upd.status).toBe(200);
    expect((await w.api(w.owner, w.R.purchaseId.PUT, { method: "PUT", params: { id }, body: { version: c.body.version, supplierId: w.ids.supplier, docDate: "2026-04-01", paymentType: "CREDIT", currency: "IQD", lines: [{ productId: P, uom: "قطعة", qty: "1", unitPrice: "1" }] } })).status).toBe(409);   // stale version
    const dup = await w.api(w.owner, w.R.purchases.POST, { method: "POST", body: { supplierId: w.ids.supplier, docDate: "2026-04-01", paymentType: "CREDIT", currency: "IQD", supplierInvoiceNo: "INV-77", lines: [{ productId: P, uom: "قطعة", qty: "1", unitPrice: "1" }] } });
    expect(dup.status).toBe(409);                                  // same supplier invoice number cannot be entered twice
    const post = await w.api(w.owner, w.R.purchasePost, { method: "POST", params: { id } });
    expect(post.status).toBe(200); expect(post.body.docNo).toMatch(/^PO-2026-\d{6}$/);
    expect((await w.api(w.owner, w.R.purchaseId.PUT, { method: "PUT", params: { id }, body: { version: 99, supplierId: w.ids.supplier, docDate: "2026-04-01", paymentType: "CREDIT", currency: "IQD", lines: [{ productId: P, uom: "قطعة", qty: "1", unitPrice: "1" }] } })).body.error.code).toBe("NOT_DRAFT");
    expect((await w.api(w.owner, w.R.purchaseId.DELETE, { method: "DELETE", params: { id } })).status).toBe(409);
    await expectFail(w.inject((tx) => tx`UPDATE purchase_orders SET total = 1 WHERE id = ${id}`), /POSTED_DOCUMENT_IMMUTABLE/);
    await expectFail(w.inject((tx) => tx`UPDATE purchase_lines SET qty = 1 WHERE purchase_id = ${id}`), /LINES_LOCKED/);
    await expectFail(w.inject((tx) => tx`DELETE FROM purchase_orders WHERE id = ${id}`), /ONLY_DRAFT/);
  });
  it("a draft can be deleted", async () => {
    const c = await w.api(w.owner, w.R.purchases.POST, { method: "POST", body: { supplierId: w.ids.supplier, docDate: "2026-04-02", paymentType: "CREDIT", currency: "IQD", lines: [{ productId: P, uom: "قطعة", qty: "1", unitPrice: "1" }] } });
    expect((await w.api(w.owner, w.R.purchaseId.DELETE, { method: "DELETE", params: { id: c.body.id } })).status).toBe(200);
  });
  it("reversing an untouched purchase restores the books; a purchase whose goods moved cannot be reversed", async () => {
    const ok = await w.api(w.owner, w.R.purchaseReverse, { method: "POST", params: { id }, body: { reason: "فاتورة مكررة" } });
    expect(ok.status).toBe(200);
    expect((await w.api(w.owner, w.R.purchaseId.GET, { params: { id } })).body.status).toBe("REVERSED");
    const r2 = await w.api(w.owner, w.R.purchaseReverse, { method: "POST", params: { id }, body: { reason: "مرة ثانية" } });
    expect(r2.status).toBe(409);
    const b = await w.buy({ product: P, qty: "10", price: "100" });
    await sell(w, P, w.ids.main, "3");
    const bad = await w.api(w.owner, w.R.purchaseReverse, { method: "POST", params: { id: b.id }, body: { reason: "اختبار" } });
    expect(bad.status).toBe(409); expect(bad.body.error.code).toBe("PURCHASE_LOT_CONSUMED");
    expect((await w.recon()).ok).toBe(true); expect((await w.tb()).balanced).toBe(true);
  });
  it("supplier statement shows running balance from the ledger", async () => {
    const s = (await w.api(w.owner, w.R.statement, { params: { id: w.ids.supplier } })).body;
    expect(s.lines.length).toBeGreaterThan(0);
    expect(s.lines[s.lines.length - 1].balance).toBe(s.balance);
  });
});

describe("units of measure and precision", () => {
  it("per-product carton factors; invalid precision rejected; units frozen after movements", async () => {
    const A = await w.mkProduct("UOM-A", { uoms: [{ uom: "كارتون", factorToBase: "12" }, { uom: "نصف", factorToBase: "0.5" }] });
    const B = await w.mkProduct("UOM-B", { uoms: [{ uom: "كارتون", factorToBase: "24" }] });
    const a = await w.buy({ product: A, qty: "2", price: "60000", uom: "كارتون" }); const b = await w.buy({ product: B, qty: "2", price: "60000", uom: "كارتون" });
    const la = (await w.api(w.owner, w.R.lots, { params: { id: A } })).body[0], lb = (await w.api(w.owner, w.R.lots, { params: { id: B } })).body[0];
    expect(Number(la.qtyReceived)).toBe(24); expect(Number(lb.qtyReceived)).toBe(48);      // a carton is NOT a fixed number
    expect(la.unitCostBase).toBe("5000.0000"); expect(lb.unitCostBase).toBe("2500.0000");   // 120,000 / 24 and / 48
    void a; void b;
    const bad = await w.buy({ product: A, qty: "1", price: "100", uom: "نصف" });
    expect(bad.body.error.code).toBe("BAD_QTY_PRECISION");
    const unknown = await w.buy({ product: A, qty: "1", price: "100", uom: "صندوق" });
    expect(unknown.body.error.code).toBe("UNKNOWN_UOM");
    const frozen = await w.api(w.owner, w.R.productId.PATCH, { method: "PATCH", params: { id: A }, body: { baseUom: "كغم", version: 1 } });
    expect(frozen.body.error.code).toBe("PRODUCT_HAS_MOVEMENTS");
  });
  it("floating-point-sensitive totals stay exact (0.1+0.2 class of bugs)", async () => {
    const P = await w.mkProduct("DEC", { qtyDecimals: 3, baseUom: "كغم" });
    const r = await w.buy({ product: P, qty: "0.3", price: "1000.1", uom: "كغم", currency: "USD", rate: "1450.5", type: "CREDIT" });
    expect(r.status).toBe(200);
    const g = (await w.api(w.owner, w.R.purchaseId.GET, { params: { id: r.id } })).body;
    expect(g.total).toBe("300.0300"); expect(Number(g.totalBase)).toBe(435194);   // 300.03 USD * 1450.5 = 435,193.515 -> 435,194 (half-up, no float drift)
    expect((await w.tb()).balanced).toBe(true);
  });
});

describe("physical count and permissions", () => {
  let P: string;
  it("shortage consumes FIFO (loss in 5200); surplus needs an explicit unit cost; only the owner can approve", async () => {
    P = await w.mkProduct("CNT");
    await w.buy({ product: P, qty: "10", price: "1000" }); await w.buy({ product: P, qty: "10", price: "2000" });
    const mk = (counted: string, cost?: string) => w.api(w.owner, w.R.counts.POST, { method: "POST", body: { docDate: "2026-05-01", locationId: w.ids.main, reason: "جرد دوري", lines: [{ productId: P, countedQtyBase: counted, unitCostBase: cost }] } });
    const short = await mk("18");
    expect((await w.api(w.acct, w.R.countPost, { method: "POST", params: { id: short.body.id } })).status).toBe(403);   // owner-only approval
    const r = await w.api(w.owner, w.R.countPost, { method: "POST", params: { id: short.body.id } });
    expect(r.body.shortageBase).toBe("2000");                       // 2 missing from the OLDEST layer @1000
    expect(bal(await w.tb(), "5200")).toBe(2000);
    const sur = await mk("20");                                      // system 18 -> +2
    const noCost = await w.api(w.owner, w.R.countPost, { method: "POST", params: { id: sur.body.id } });
    expect(noCost.body.error.code).toBe("SURPLUS_NEEDS_UNIT_COST");
    const sur2 = await mk("20", "1500");
    const ok = await w.api(w.owner, w.R.countPost, { method: "POST", params: { id: sur2.body.id } });
    expect(ok.body.surplusBase).toBe("3000");
    expect(bal(await w.tb(), "5200")).toBe(-1000);                   // net: 2000 loss - 3000 gain
    expect((await w.recon()).ok).toBe(true);
  });
  it("accountant (default grants) can create+post purchases but cannot reverse them or see/touch owner-only areas", async () => {
    const P2 = await w.mkProduct("ACC");
    const r = await w.buy({ product: P2, qty: "5", price: "100", session: w.acct });
    expect(r.status).toBe(200);
    expect((await w.api(w.acct, w.R.purchaseReverse, { method: "POST", params: { id: r.id }, body: { reason: "اختبار" } })).status).toBe(403);
    expect((await w.api(w.acct, w.R.trial)).status).toBe(200);       // journal:view granted
  });
  it("database refuses an unbalanced journal entry and any journal mutation even from the app role", async () => {
    await expectFail(w.inject((tx, a, l) => l.postJournal(tx, a, { date: "2026-05-02", sourceDocType: "x", sourceDocId: crypto.randomUUID(), lines: [{ account: "1110", debit: "100" }, { account: "3100", credit: "99" }] })), /UNBALANCED/);
    // bypass the service: raw unbalanced rows must still be refused by the database at COMMIT
    await expectFail(w.inject(async (tx, a) => {
      const [je] = await tx`INSERT INTO journal_entries(company_id, entry_no, entry_date, source_doc_type, source_doc_id, posted_by) VALUES (${a.companyId}, 'RAW-1', '2026-05-02', 'x', ${crypto.randomUUID()}, ${a.userId}) RETURNING id`;
      const [acc] = await tx`SELECT id FROM accounts WHERE code = '1110'`;
      await tx`INSERT INTO journal_lines(company_id, entry_id, line_no, account_id, debit_base, currency, amount_orig, fx_rate_snapshot) VALUES (${a.companyId}, ${je!.id}, 1, ${acc!.id}, 5, 'IQD', 5, 1)`;
    }), /UNBALANCED_ENTRY|ENTRY_NEEDS_TWO_LINES/);
    await expectFail(w.inject((tx) => tx`UPDATE journal_lines SET debit_base = debit_base + 1`), /IMMUTABLE_TABLE/);
    await expectFail(w.inject((tx) => tx`DELETE FROM stock_movements`), /permission denied|IMMUTABLE_TABLE/);
    await expectFail(w.inject((tx) => tx`UPDATE stock_lots SET qty_remaining = -1`), /check constraint/);
  });
});

describe("landed costs: transport inside or outside inventory cost (configurable)", () => {
  const withCharge = (P: string, charge: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    w.api(w.owner, w.R.purchases.POST, { method: "POST", body: { supplierId: w.ids.supplier, docDate: "2026-11-01", paymentType: "CREDIT", currency: "IQD", lines: [{ productId: P, uom: "قطعة", qty: "100", unitPrice: "10000" }], charges: [charge], ...extra } });
  const post = (id: string) => w.api(w.owner, w.R.purchasePost, { method: "POST", params: { id } });
  const unitCost = async (P: string) => (await w.api(w.owner, w.R.lots, { params: { id: P } })).body.map((l: any) => Number(l.unitCostBase));

  it("capitalised transport raises the layer cost; the payable includes it; nothing is expensed", async () => {
    const P = await w.mkProduct("LC1");
    const before = await w.tb();
    const c = await withCharge(P, { kind: "TRANSPORT", amount: "50000", capitalize: true });
    const r = await post(c.body.id); expect(r.status).toBe(200);
    expect(await unitCost(P)).toEqual([10500]);                           // (1,000,000 + 50,000) / 100
    const tb = await w.tb();
    expect(bal(tb, "1300") - bal(before, "1300")).toBe(1050000);
    expect(bal(tb, "6100") - bal(before, "6100")).toBe(0);
    expect(-bal(tb, "2100") - -bal(before, "2100")).toBe(1050000);        // supplier is owed goods + freight
    expect((await w.recon()).ok).toBe(true); expect(tb.balanced).toBe(true);
  });
  it("expensed transport leaves the layer at the goods price and books 6100", async () => {
    const P = await w.mkProduct("LC2");
    const before = await w.tb();
    const r = await post((await withCharge(P, { kind: "TRANSPORT", amount: "50000", capitalize: false })).body.id); expect(r.status).toBe(200);
    expect(await unitCost(P)).toEqual([10000]);
    const tb = await w.tb();
    expect(bal(tb, "6100") - bal(before, "6100")).toBe(50000);
    expect(bal(tb, "1300") - bal(before, "1300")).toBe(1000000);
    expect(-bal(tb, "2100") - -bal(before, "2100")).toBe(1050000);
    expect((await w.recon()).ok).toBe(true); expect(tb.balanced).toBe(true);
  });
  it("company policy INCLUDE makes charges capitalised by default; EXCLUDE expenses them", async () => {
    const co = await import("@/app/api/company/route");
    const patch = async (policy: string) => { const g = (await w.api(w.owner, co.GET)).body; return w.api(w.owner, co.PATCH, { method: "PATCH", body: { name: g.name, phones: [], allowNegativeStock: false, landedCostPolicy: policy, version: g.version } }); };
    expect((await patch("INCLUDE")).status).toBe(200);
    const P = await w.mkProduct("LC3");
    await post((await withCharge(P, { kind: "TRANSPORT", amount: "50000" })).body.id);
    expect(await unitCost(P)).toEqual([10500]);
    expect((await patch("EXCLUDE")).status).toBe(200);
    const P2 = await w.mkProduct("LC4");
    await post((await withCharge(P2, { kind: "TRANSPORT", amount: "50000" })).body.id);
    expect(await unitCost(P2)).toEqual([10000]);
  });
  it("capitalised charge is spread pro-rata over several lines with no lost dinar", async () => {
    const A = await w.mkProduct("LC5A"), B = await w.mkProduct("LC5B");
    const c = await w.api(w.owner, w.R.purchases.POST, { method: "POST", body: { supplierId: w.ids.supplier, docDate: "2026-11-02", paymentType: "CREDIT", currency: "IQD",
      lines: [{ productId: A, uom: "قطعة", qty: "1", unitPrice: "1000" }, { productId: B, uom: "قطعة", qty: "1", unitPrice: "2000" }], charges: [{ kind: "CUSTOMS", amount: "100", capitalize: true }] } });
    await post(c.body.id);
    expect(await unitCost(A)).toEqual([1033]); expect(await unitCost(B)).toEqual([2067]);       // 33 + 67 = 100
    expect((await w.recon()).ok).toBe(true); expect((await w.tb()).balanced).toBe(true);
  });
  it("a supplier return from a landed-cost layer takes back the landed cost too; reversal restores the books", async () => {
    const P = await w.mkProduct("LC6");
    const c = await withCharge(P, { kind: "TRANSPORT", amount: "50000", capitalize: true }); await post(c.body.id);
    const g = (await w.api(w.owner, w.R.purchaseId.GET, { params: { id: c.body.id } })).body;
    const d = await w.api(w.owner, w.R.returns.POST, { method: "POST", body: { purchaseId: c.body.id, docDate: "2026-11-03", settlement: "REDUCE_PAYABLE", reason: "اختبار", lines: [{ purchaseLineId: g.lines[0].id, qtyBase: "100" }] } });
    const r = await w.api(w.owner, w.R.returnPost, { method: "POST", params: { id: d.body.id } });
    expect(r.body.totalBase).toBe("1050000");                              // goods + freight
    expect((await w.recon()).ok).toBe(true);
    const P2 = await w.mkProduct("LC7");
    const c2 = await withCharge(P2, { kind: "OTHER", amount: "1234", capitalize: false }); const p2 = await post(c2.body.id);
    const before = await w.tb();
    expect((await w.api(w.owner, w.R.purchaseReverse, { method: "POST", params: { id: c2.body.id }, body: { reason: "اختبار" } })).status).toBe(200);
    const after = await w.tb();
    expect(bal(after, "6900") - bal(before, "6900")).toBe(-1234); expect(after.balanced).toBe(true); void p2;
  });
});
