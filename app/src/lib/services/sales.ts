import { z } from "zod";
import Decimal from "decimal.js";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { d, roundMoney, toBase } from "../money";
import { postJournal, reverseEntry, type JLine } from "../ledger";
import { consumeFifo, inventoryAccountOf, restoreConsumptions, restoreForReturn, undoReturnRestock } from "../inventory";
import { currencyCode, dateStr, draftRef, mainLocationId, moneyStr, qtyStr, rateStr, resolveRate, toBaseQty, uuid, yearOf } from "./common";
import { createCashReceipt, postReceipt, reverseReceiptCore, unpostReceipt } from "./receipts";
import { assertCashAvailable } from "./cash";

const dateOf = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

// =========================== invoice financial position ===========================
const FOREVER = "9999-12-31";
/** Money state of an invoice; with `asOf` only documents dated on or before that day count (settlement cut-off). Reversed documents never count. */
export async function invoiceFinancials(tx: Tx, invoiceId: string, asOf: string = FOREVER) {
  const [r] = await tx`SELECT si.net::text AS net, si.currency, si.sale_type,
      COALESCE((SELECT sum(a.amount) FROM receipt_allocations a JOIN customer_receipts cr ON cr.id = a.receipt_id WHERE a.invoice_id = si.id AND cr.status = 'POSTED' AND cr.doc_date <= ${asOf} AND NOT a.external), 0)::text AS collected,
      COALESCE((SELECT sum(a.amount) FROM receipt_allocations a JOIN customer_receipts cr ON cr.id = a.receipt_id WHERE a.invoice_id = si.id AND cr.status = 'POSTED' AND cr.doc_date <= ${asOf} AND a.external), 0)::text AS external,
      COALESCE((SELECT sum(value_orig) FROM sales_returns WHERE invoice_id = si.id AND status = 'POSTED' AND doc_date <= ${asOf}), 0)::text AS returned,
      COALESCE((SELECT sum(applied_orig) FROM sales_returns WHERE invoice_id = si.id AND status = 'POSTED' AND doc_date <= ${asOf}), 0)::text AS applied,
      COALESCE((SELECT sum(refund_orig) FROM sales_returns WHERE invoice_id = si.id AND status = 'POSTED' AND doc_date <= ${asOf}), 0)::text AS refunds
    FROM sales_invoices si WHERE si.id = ${invoiceId}`;
  if (!r) throw notFound();
  const outstanding = Decimal.max(d(r.net).minus(r.collected).minus(r.external).minus(r.applied), 0);
  return { net: r.net as string, currency: r.currency as string, collected: r.collected as string, external: r.external as string, returned: r.returned as string, appliedToReceivable: r.applied as string,
    cashRefunds: r.refunds as string, adjustedNet: d(r.net).minus(r.returned).toString(), netCollected: d(r.collected).plus(r.external).minus(r.refunds).toString(), outstanding: outstanding.toString() };
}

/**
 * Profit figures of one invoice (base currency) as of a date (policy §2/§6):
 *  - only the DELIVERED share of the invoice is earned: recognised value = delivered qty / invoiced qty of each line, cost = FIFO cost of what was delivered;
 *  - linkedProfit = the earned profit, but ONLY when the invoice is fully delivered and fully paid (net collected >= value in its own currency); otherwise 0 — a partial collection is just a collection;
 *  - it is a RESTRICTION indicator for distributing profit, not new accounting profit. Zero/negative earned value => 0.
 */
export async function invoiceProfit(tx: Tx, invoiceId: string, asOf: string = FOREVER) {
  const zero = { grossProfitBase: "0", adjustedProfitBase: "0", collectedRatio: "0", linkedProfitBase: "0", deliveredRatio: "0", recognizedNetBase: "0", recognizedNetOrig: "0", cogsBase: "0" };
  if ((await tx`SELECT is_opening FROM sales_invoices WHERE id = ${invoiceId}`)[0]?.is_opening) return zero;   // opening balances carry no profit
  const fin = await invoiceFinancials(tx, invoiceId, asOf);
  const lines = await tx`SELECT sl.id, sl.qty_base::text AS q, sl.net_line_base::text AS nb, sl.net_line_orig::text AS no,
      COALESCE((SELECT sum(dl.qty_base) FROM delivery_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_id WHERE dl.sales_line_id = sl.id AND dn.status = 'POSTED' AND dn.doc_date <= ${asOf}), 0)::text AS dq,
      COALESCE((SELECT sum(dl.cost_base) FROM delivery_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_id WHERE dl.sales_line_id = sl.id AND dn.status = 'POSTED' AND dn.doc_date <= ${asOf}), 0)::text AS cogs
    FROM sales_lines sl WHERE sl.invoice_id = ${invoiceId}`;
  const [ret] = await tx`SELECT COALESCE(sum(value_base), 0)::text AS vb, COALESCE(sum(cogs_base), 0)::text AS cg FROM sales_returns WHERE invoice_id = ${invoiceId} AND status = 'POSTED' AND doc_date <= ${asOf}`;
  let recB = d(0), recO = d(0), cogs = d(0), qAll = d(0), qDel = d(0);
  for (const l of lines) {
    const full = d(l.dq).gte(l.q);
    recB = recB.plus(full ? l.nb : roundMoney(d(l.nb).mul(l.dq).div(l.q), "IQD"));
    recO = recO.plus(full ? l.no : d(l.no).mul(l.dq).div(l.q));
    cogs = cogs.plus(l.cogs); qAll = qAll.plus(l.q); qDel = qDel.plus(l.dq);
  }
  const adjRecB = recB.minus(ret!.vb), adjCogs = cogs.minus(ret!.cg), adjRecO = recO.minus(fin.returned);
  const grossProfit = recB.minus(cogs), adjustedProfit = adjRecB.minus(adjCogs);
  // Policy (owner decision): profit of an invoice becomes eligible for distribution ONLY when it is fully paid AND fully delivered. Partial collection is just a collection.
  const fullyDelivered = lines.length > 0 && lines.every((l) => d(l.dq).gte(l.q));
  const fullyPaid = d(fin.netCollected).gte(adjRecO) && adjRecO.gt(0);
  const ratio = fullyDelivered && fullyPaid ? d(1) : d(0);
  return { grossProfitBase: grossProfit.toString(), adjustedProfitBase: adjustedProfit.toString(), collectedRatio: ratio.toDecimalPlaces(8).toString(), linkedProfitBase: roundMoney(adjustedProfit.mul(ratio), "IQD").toString(),
    deliveredRatio: qAll.gt(0) ? qDel.div(qAll).toDecimalPlaces(8).toString() : "0", recognizedNetBase: adjRecB.toString(), recognizedNetOrig: adjRecO.toDecimalPlaces(4).toString(), cogsBase: adjCogs.toString() };
}

// =========================== invoices ===========================
const lineIn = z.object({ productId: uuid, uom: z.string().min(1).max(30), qty: qtyStr, unitPrice: moneyStr, lineDiscount: moneyStr.default("0"), locationId: uuid.nullish() });
export const invoiceSchema = z.object({
  customerId: uuid, docDate: dateStr, saleType: z.enum(["CASH", "CREDIT"]), cashAccountId: uuid.nullish(), dueDate: dateStr.nullish(), eventDate: dateStr.nullish(),
  currency: currencyCode, exchangeRate: rateStr.nullish(), deliveryMode: z.enum(["WITH_INVOICE", "SEPARATE"]).default("WITH_INVOICE"),
  discount: moneyStr.default("0"), terms: z.string().max(1000).nullish(), notes: z.string().max(1000).nullish(), quoteId: uuid.nullish(),
  lines: z.array(lineIn).min(1).max(200),
});
export const invoiceUpdateSchema = invoiceSchema.extend({ version: z.number().int() });

async function prepareInvoice(tx: Tx, i: z.infer<typeof invoiceSchema>) {
  const [c] = await tx`SELECT kind, is_archived, payment_terms_days FROM contacts WHERE id = ${i.customerId}`;
  if (!c || c.kind === "SUPPLIER") throw badRequest("NOT_A_CUSTOMER", "الجهة المختارة ليست عميلاً");
  if (c.is_archived) throw conflict("CUSTOMER_ARCHIVED", "العميل مؤرشف");
  if (i.saleType === "CASH") {
    const [ca] = await tx`SELECT currency FROM cash_accounts WHERE id = ${i.cashAccountId ?? null} AND is_active`;
    if (!ca) throw badRequest("CASH_ACCOUNT_REQUIRED", "اختر الصندوق (أو عهدة الشريك) للبيع النقدي");
    if (ca.currency !== i.currency) throw badRequest("CASH_CURRENCY_MISMATCH", "عملة الصندوق يجب أن تطابق عملة الفاتورة");
  }
  const rate = await resolveRate(tx, i.currency, i.docDate, i.exchangeRate ?? undefined);
  const main = await mainLocationId(tx);
  const lines = [];
  for (const l of i.lines) {
    const qtyBase = await toBaseQty(tx, l.productId, l.uom, l.qty);
    const t = roundMoney(d(l.qty).mul(l.unitPrice).minus(l.lineDiscount), i.currency);
    if (t.lt(0)) throw badRequest("DISCOUNT_EXCEEDS_LINE", "خصم البند أكبر من قيمته");
    lines.push({ ...l, qtyBase, lineTotal: t.toString(), locationId: l.locationId ?? main });
  }
  const gross = lines.reduce((s, l) => s.plus(l.lineTotal), d(0)), disc = roundMoney(i.discount, i.currency);
  if (disc.gt(gross)) throw badRequest("DISCOUNT_EXCEEDS_TOTAL", "الخصم أكبر من الإجمالي");
  const dueDate = i.dueDate ?? (i.saleType === "CREDIT" && c.payment_terms_days > 0 ? new Date(Date.parse(i.docDate) + c.payment_terms_days * 86400000).toISOString().slice(0, 10) : null);
  return { rate, lines, gross, disc, net: gross.minus(disc), dueDate };
}
async function writeInvLines(tx: Tx, companyId: string, id: string, lines: Awaited<ReturnType<typeof prepareInvoice>>["lines"]) {
  await tx`DELETE FROM sales_lines WHERE invoice_id = ${id}`;
  let n = 0;
  for (const l of lines) { n += 1; await tx`INSERT INTO sales_lines(company_id, invoice_id, line_no, product_id, uom, qty, qty_base, unit_price, line_discount, line_total, location_id)
    VALUES (${companyId}, ${id}, ${n}, ${l.productId}, ${l.uom}, ${l.qty}, ${l.qtyBase}, ${l.unitPrice}, ${l.lineDiscount}, ${l.lineTotal}, ${l.locationId})`; }
}

export async function createInvoice(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof invoiceSchema>) {
  const p = await prepareInvoice(tx, i);
  const [h] = await tx`INSERT INTO sales_invoices(company_id, draft_ref, doc_date, event_date, customer_id, sale_type, cash_account_id, due_date, quote_id, delivery_mode, currency, exchange_rate_snapshot, gross, discount, net, terms, notes, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${i.docDate}, ${i.eventDate ?? null}, ${i.customerId}, ${i.saleType}, ${i.saleType === "CASH" ? i.cashAccountId! : null}, ${p.dueDate}, ${i.quoteId ?? null}, ${i.deliveryMode}, ${i.currency}, ${p.rate},
            ${p.gross.toString()}, ${p.disc.toString()}, ${p.net.toString()}, ${i.terms ?? null}, ${i.notes ?? null}, ${who.userId}) RETURNING id, draft_ref AS "draftRef", version`;
  await writeInvLines(tx, who.companyId, h!.id, p.lines);
  await audit(tx, actor, { action: "sales_invoice.create_draft", entityType: "sales_invoice", entityId: h!.id, after: { net: p.net.toString(), currency: i.currency } });
  return h!;
}

export async function updateInvoice(tx: Tx, who: Principal, actor: Actor, id: string, i: z.infer<typeof invoiceUpdateSchema>) {
  const [cur] = await tx`SELECT status, version FROM sales_invoices WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.status !== "DRAFT") throw conflict("NOT_DRAFT", "لا يمكن تعديل مستند غير مسودة");
  if (cur.version !== i.version) throw conflict("VERSION_CONFLICT", "تم تعديل المسودة من جهة أخرى");
  const p = await prepareInvoice(tx, i);
  await writeInvLines(tx, who.companyId, id, p.lines);
  const [h] = await tx`UPDATE sales_invoices SET doc_date = ${i.docDate}, event_date = ${i.eventDate ?? null}, customer_id = ${i.customerId}, sale_type = ${i.saleType}, cash_account_id = ${i.saleType === "CASH" ? i.cashAccountId! : null},
      due_date = ${p.dueDate}, delivery_mode = ${i.deliveryMode}, currency = ${i.currency}, exchange_rate_snapshot = ${p.rate}, gross = ${p.gross.toString()}, discount = ${p.disc.toString()}, net = ${p.net.toString()},
      terms = ${i.terms ?? null}, notes = ${i.notes ?? null}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, version`;
  await audit(tx, actor, { action: "sales_invoice.update_draft", entityType: "sales_invoice", entityId: id, after: { net: p.net.toString() } });
  return h!;
}

export async function deleteInvoiceDraft(tx: Tx, actor: Actor, id: string) {
  const [cur] = await tx`SELECT status FROM sales_invoices WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.status !== "DRAFT") throw conflict("NOT_DRAFT", "الحذف للمسودات فقط");
  await tx`DELETE FROM sales_lines WHERE invoice_id = ${id}`;
  await tx`DELETE FROM sales_invoices WHERE id = ${id}`;
  await audit(tx, actor, { action: "sales_invoice.delete_draft", entityType: "sales_invoice", entityId: id });
}

export async function listInvoices(tx: Tx, status?: string) {
  const rows = await tx`SELECT si.id, si.customer_id AS "customerId", si.draft_ref AS "draftRef", si.doc_no AS "docNo", si.doc_date::text AS "docDate", c.name AS "customerName", si.sale_type AS "saleType", si.currency, si.net::text AS net, si.status, si.due_date::text AS "dueDate",
      CASE WHEN si.status = 'POSTED' THEN (si.net - COALESCE((SELECT sum(a.amount) FROM receipt_allocations a JOIN customer_receipts cr ON cr.id = a.receipt_id WHERE a.invoice_id = si.id AND cr.status = 'POSTED'), 0)
        - COALESCE((SELECT sum(applied_orig) FROM sales_returns WHERE invoice_id = si.id AND status = 'POSTED'), 0))::text END AS outstanding
    FROM sales_invoices si JOIN contacts c ON c.id = si.customer_id WHERE ((${status ?? null}::text IS NULL AND si.status <> 'REVERSED') OR si.status = ${status ?? null}) ORDER BY si.doc_date DESC, si.created_at DESC LIMIT 300`;
  return rows;
}

export async function getInvoice(tx: Tx, id: string) {
  const [h] = await tx`SELECT si.id, si.draft_ref AS "draftRef", si.doc_no AS "docNo", si.doc_date::text AS "docDate", si.event_date::text AS "eventDate", si.customer_id AS "customerId", c.name AS "customerName", c.phones AS "customerPhones", c.address AS "customerAddress",
      si.sale_type AS "saleType", si.cash_account_id AS "cashAccountId", si.due_date::text AS "dueDate", si.delivery_mode AS "deliveryMode", si.currency, si.exchange_rate_snapshot::text AS "exchangeRate",
      si.gross::text AS gross, si.discount::text AS discount, si.net::text AS net, si.net_base::text AS "netBase", si.terms, si.notes, si.status, si.version
    FROM sales_invoices si JOIN contacts c ON c.id = si.customer_id WHERE si.id = ${id}`;
  if (!h) throw notFound();
  const lines = await tx`SELECT sl.id, sl.line_no AS "lineNo", sl.product_id AS "productId", p.code AS "productCode", p.name AS "productName", sl.uom, sl.qty::text, sl.qty_base::text AS "qtyBase", sl.unit_price::text AS "unitPrice",
      sl.line_discount::text AS "lineDiscount", sl.line_total::text AS "lineTotal", sl.location_id AS "locationId",
      COALESCE((SELECT sum(dl.qty_base) FROM delivery_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_id WHERE dl.sales_line_id = sl.id AND dn.status = 'POSTED'), 0)::text AS delivered,
      COALESCE((SELECT sum(rl.qty_base) FROM sales_return_lines rl JOIN sales_returns r ON r.id = rl.return_id WHERE rl.sales_line_id = sl.id AND r.status = 'POSTED'), 0)::text AS returned
    FROM sales_lines sl JOIN products p ON p.id = sl.product_id WHERE sl.invoice_id = ${id} ORDER BY sl.line_no`;
  const fin = h.status === "DRAFT" ? {} : await invoiceFinancials(tx, id);
  const cogs = h.status === "DRAFT" ? null : (await tx`SELECT COALESCE(sum(dl.cost_base), 0)::text AS c FROM delivery_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_id JOIN sales_lines sl ON sl.id = dl.sales_line_id WHERE sl.invoice_id = ${id} AND dn.status = 'POSTED'`)[0]!.c;
  const profit = h.status === "DRAFT" ? null : await invoiceProfit(tx, id);
  // invoiced / delivered / collected / remaining, kept apart (policy §2): cash taken for goods not yet delivered is an advance, not earned profit
  let breakdown: Record<string, string> | null = null;
  if (h.status !== "DRAFT" && profit) {
    const f = fin as Awaited<ReturnType<typeof invoiceFinancials>>;
    const delivered = (await tx`SELECT COALESCE(sum(CASE WHEN dq >= q THEN no ELSE no * dq / q END), 0)::text AS v FROM (SELECT sl.qty_base AS q, sl.net_line_orig AS no,
        COALESCE((SELECT sum(dl.qty_base) FROM delivery_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_id WHERE dl.sales_line_id = sl.id AND dn.status = 'POSTED'), 0) AS dq FROM sales_lines sl WHERE sl.invoice_id = ${id}) x`)[0]!.v as string;
    const paid = d(f.collected).plus(f.external);
    breakdown = { invoiced: f.net, deliveredValue: d(delivered).toDecimalPlaces(4).toString(), deliveredRatio: profit.deliveredRatio, collected: f.collected, external: f.external, remaining: f.outstanding,
      advanceOnUndelivered: Decimal.max(paid.minus(delivered), 0).toDecimalPlaces(4).toString(), eligibleProfitBase: profit.linkedProfitBase };
  }
  return { ...h, lines, ...fin, cogsBase: cogs, profit, breakdown };
}

/** Posting: revenue/AR (+discount) entry; goods issue (COGS by FIFO) with the invoice or later; a CASH sale also records its receipt. One transaction. */
export async function postInvoice(tx: Tx, who: Principal, actor: Actor, id: string) {
  const [inv] = await tx`SELECT * FROM sales_invoices WHERE id = ${id} FOR UPDATE`;
  if (!inv) throw notFound();
  if (inv.status !== "DRAFT") throw conflict("NOT_DRAFT", "المستند ليس مسودة");
  const lines = await tx`SELECT * FROM sales_lines WHERE invoice_id = ${id} ORDER BY line_no`;
  if (!lines.length) throw badRequest("NO_LINES");
  const [cust] = await tx`SELECT is_archived, credit_limit::text AS lim FROM contacts WHERE id = ${inv.customer_id} FOR UPDATE`;
  if (cust!.is_archived) throw conflict("CUSTOMER_ARCHIVED");
  const fx = inv.exchange_rate_snapshot as string, cur = inv.currency as string, date = dateOf(inv.doc_date);
  const lineBase = lines.map((l) => toBase(l.line_total, fx, cur));
  const grossBase = lineBase.reduce((s, b) => s.plus(b), d(0)), discBase = toBase(inv.discount, fx, cur), netBase = grossBase.minus(discBase);
  if (inv.sale_type === "CREDIT" && cust!.lim !== null) {
    const bal = (await tx`SELECT COALESCE(sum(jl.debit_base - jl.credit_base), 0)::text AS b FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '1200' AND jl.contact_id = ${inv.customer_id}`)[0]!.b as string;
    if (d(bal).plus(netBase).gt(cust!.lim)) throw conflict("CREDIT_LIMIT_EXCEEDED", `يتجاوز الحد الائتماني للعميل (${cust!.lim}). الرصيد الحالي ${bal}`);
  }
  // spread the invoice-level discount over lines (remainder to the last line) so returns can be valued exactly
  let givenB = d(0), givenO = d(0);
  for (const [i, l] of lines.entries()) {
    const last = i === lines.length - 1;
    const shB = last ? discBase.minus(givenB) : (grossBase.gt(0) ? roundMoney(discBase.mul(lineBase[i]!).div(grossBase), "IQD") : d(0));
    const shO = last ? d(inv.discount).minus(givenO) : (d(inv.gross).gt(0) ? roundMoney(d(inv.discount).mul(l.line_total).div(inv.gross), cur) : d(0));
    givenB = givenB.plus(shB); givenO = givenO.plus(shO);
    await tx`UPDATE sales_lines SET line_total_base = ${lineBase[i]!.toString()}, net_line_base = ${lineBase[i]!.minus(shB).toString()}, net_line_orig = ${d(l.line_total).minus(shO).toString()} WHERE id = ${l.id}`;
  }
  const docNo = (inv.doc_no as string | null) ?? (await tx`SELECT next_document_number(${who.companyId}, 'sales_invoice', ${yearOf(date)}) AS n`)[0]!.n as string;   // an amended invoice keeps its number
  const deferred = inv.delivery_mode === "SEPARATE" && !inv.is_opening;                // revenue is recognised when goods are delivered (docs/ACCOUNTING_POLICY.md §2)
  const jl: JLine[] = [{ account: "1200", debit: netBase, currency: cur, amountOrig: inv.net, fx, contactId: inv.customer_id }];
  if (deferred) jl.push({ account: "2600", credit: netBase, currency: cur, amountOrig: inv.net, fx });
  else {
    if (discBase.gt(0)) jl.push({ account: "4150", debit: discBase, currency: cur, amountOrig: inv.discount, fx });
    jl.push({ account: "4100", credit: grossBase, currency: cur, amountOrig: inv.gross, fx });
  }
  const je = await postJournal(tx, actor, { date, sourceDocType: "sales_invoice", sourceDocId: id, memo: `فاتورة بيع ${docNo}`, lines: jl });
  const [h] = await tx`UPDATE sales_invoices SET status = 'POSTED', doc_no = ${docNo}, gross_base = ${grossBase.toString()}, discount_base = ${discBase.toString()}, net_base = ${netBase.toString()}, revenue_deferred = ${deferred},
      posted_by = ${who.userId}, posted_at = now(), journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, doc_no AS "docNo", status, version`;
  let deliveryNo: string | null = null;
  if (inv.delivery_mode === "WITH_INVOICE") {
    const dn = await createDeliveryDraft(tx, who, actor, { invoiceId: id, docDate: date, lines: lines.map((l) => ({ salesLineId: l.id, qtyBase: l.qty_base })), autoCreated: true });
    deliveryNo = (await postDelivery(tx, who, actor, dn.id)).docNo;
  }
  if (inv.sale_type === "CASH") {
    await createCashReceipt(tx, who, actor, { customerId: inv.customer_id, docDate: date, cashAccountId: inv.cash_account_id, currency: cur, rate: fx, amount: inv.net, invoiceId: id, auto: true });
  }
  await audit(tx, actor, { action: "sales_invoice.post", entityType: "sales_invoice", entityId: id, after: { docNo, netBase: netBase.toString(), deliveryNo } });
  return { ...h!, deliveryNo };
}

export const reverseSchema = z.object({ reason: z.string().min(3).max(500), cascade: z.boolean().default(false) });

export async function reverseInvoice(tx: Tx, who: Principal, actor: Actor, id: string, reason: string, cascade = false) {
  const [inv] = await tx`SELECT * FROM sales_invoices WHERE id = ${id} FOR UPDATE`;
  if (!inv) throw notFound();
  if (inv.status !== "POSTED") throw conflict("NOT_POSTED", "يمكن عكس المستند المرحّل فقط");
  if ((await tx`SELECT 1 FROM sales_returns WHERE invoice_id = ${id} AND status = 'POSTED'`).length) throw conflict("HAS_RETURNS", "يوجد مرتجع مرحّل؛ اعكسه أولاً");
  if (cascade) {                                                                      // delete the invoice together with the receipts that were collected on it
    for (const r of await tx`SELECT DISTINCT r.id, r.doc_no FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id WHERE a.invoice_id = ${id} AND r.status = 'POSTED' AND r.auto_for_invoice_id IS DISTINCT FROM ${id}`) {
      if ((await tx`SELECT count(DISTINCT invoice_id)::int AS n FROM receipt_allocations WHERE receipt_id = ${r.id}`)[0]!.n > 1) throw conflict("MULTI_INVOICE_RECEIPT", `السند ${r.doc_no} مخصَّص لعدة فواتير؛ عدّله أو احذفه أولاً`);
      await reverseReceiptCore(tx, who, actor, r.id as string, `حذف الفاتورة: ${reason}`);
    }
  }
  if ((await tx`SELECT 1 FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id WHERE a.invoice_id = ${id} AND r.status = 'POSTED' AND r.auto_for_invoice_id IS DISTINCT FROM ${id}`).length)
    throw conflict("HAS_RECEIPTS", "توجد سندات قبض مخصصة لهذه الفاتورة؛ اعكسها أولاً");
  for (const r of await tx`SELECT id FROM customer_receipts WHERE auto_for_invoice_id = ${id} AND status = 'POSTED'`) await reverseReceiptCore(tx, who, actor, r.id, `عكس الفاتورة: ${reason}`);
  for (const dn of await tx`SELECT id FROM delivery_notes WHERE invoice_id = ${id} AND status = 'POSTED'`) await reverseDeliveryCore(tx, who, actor, dn.id, `عكس الفاتورة: ${reason}`);
  await reverseEntry(tx, actor, inv.journal_entry_id, new Date().toISOString().slice(0, 10), `عكس فاتورة بيع ${inv.doc_no}: ${reason}`);
  await tx`UPDATE sales_invoices SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "sales_invoice.reverse", entityType: "sales_invoice", entityId: id, reason });
  return { id, status: "REVERSED" };
}

/**
 * Edit a POSTED invoice. Its number does not change and no "reversal" is shown to the user: the old record is silently reversed (stock back, ledger undone — the journal itself stays append-only),
 * renamed "<no>~rXXXX" and hidden from the lists, then a new record carrying the ORIGINAL number is created and posted. Refused when the invoice has payments, returns or is in an approved profit settlement.
 */
export async function amendInvoice(tx: Tx, who: Principal, actor: Actor, id: string, i: z.infer<typeof invoiceUpdateSchema>) {
  const [inv] = await tx`SELECT * FROM sales_invoices WHERE id = ${id} FOR UPDATE`;
  if (!inv) throw notFound();
  if (inv.status !== "POSTED") throw conflict("NOT_POSTED", "التعديل بهذه الطريقة للفواتير المرحّلة فقط");
  if (inv.version !== i.version) throw conflict("VERSION_CONFLICT", "تم تعديل الفاتورة من جهة أخرى؛ أعد فتحها");
  if ((await tx`SELECT 1 FROM profit_settlement_lines l JOIN profit_settlements s ON s.id = l.settlement_id WHERE l.invoice_id = ${id} AND s.status = 'POSTED'`).length)
    throw conflict("IN_SETTLEMENT", "أرباح هذه الفاتورة داخلة في تسوية أرباح معتمدة؛ اعكس التسوية أولاً");
  if (inv.delivery_mode === "SEPARATE" && (await tx`SELECT 1 FROM delivery_notes WHERE invoice_id = ${id} AND status = 'POSTED'`).length)
    throw conflict("HAS_DELIVERIES", "توجد سندات تسليم مرحّلة لهذه الفاتورة؛ اعكسها أولاً");
  // receipts collected on this invoice follow it: un-post them (same numbers), edit the invoice, then re-link and re-post them
  const rcs = (await tx`SELECT DISTINCT r.id FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id WHERE a.invoice_id = ${id} AND r.status = 'POSTED' AND r.auto_for_invoice_id IS DISTINCT FROM ${id}`).map((r) => r.id as string);
  for (const r of rcs) await unpostReceipt(tx, actor, r, "تعديل الفاتورة — إعادة احتساب سند القبض");
  await reverseInvoice(tx, who, actor, id, "تعديل الفاتورة");                       // still refuses when there are returns
  await tx`SELECT set_config('app.amend', 'on', true)`;
  await tx`UPDATE sales_invoices SET doc_no = ${`${inv.doc_no}~r${Date.now().toString(36)}`}, updated_at = now() WHERE id = ${id}`;
  const created = await createInvoice(tx, who, actor, { ...i, quoteId: inv.quote_id });
  await tx`UPDATE sales_invoices SET doc_no = ${inv.doc_no}, amended_from = ${id} WHERE id = ${created.id}`;
  const posted = (await postInvoice(tx, who, actor, created.id as string)) as unknown as { docNo: string };
  if (rcs.length) {
    await tx`UPDATE receipt_allocations SET invoice_id = ${created.id} WHERE invoice_id = ${id} AND receipt_id = ANY(${rcs}::uuid[])`;
    for (const r of rcs) { try { await postReceipt(tx, who, actor, r); } catch (e) { if ((e as { code?: string }).code === "OVER_ALLOCATION") throw conflict("RECEIPT_EXCEEDS_NEW_TOTAL", "قيمة الفاتورة بعد التعديل أقل مما قُبض عليها؛ عدّل سند القبض أولاً أو زد قيمة الفاتورة"); throw e; } }
  }
  await audit(tx, actor, { action: "sales_invoice.amend", entityType: "sales_invoice", entityId: created.id, before: { id, docNo: inv.doc_no, net: inv.net }, after: { docNo: posted.docNo } });
  return { id: created.id as string, docNo: posted.docNo as string };
}

// =========================== delivery notes (goods issue + COGS) ===========================
export const deliverySchema = z.object({ invoiceId: uuid, docDate: dateStr, recipientNote: z.string().max(300).nullish(), lines: z.array(z.object({ salesLineId: uuid, qtyBase: qtyStr })).min(1).max(200) });

export async function createDeliveryDraft(tx: Tx, who: Principal, actor: Actor, i: { invoiceId: string; docDate: string; lines: { salesLineId: string; qtyBase: string }[]; autoCreated?: boolean; recipientNote?: string | null }) {
  const [inv] = await tx`SELECT status FROM sales_invoices WHERE id = ${i.invoiceId}`;
  if (!inv || inv.status !== "POSTED") throw conflict("INVOICE_NOT_POSTED", "التسليم على فاتورة مرحّلة فقط");
  const [h] = await tx`INSERT INTO delivery_notes(company_id, draft_ref, doc_date, invoice_id, auto_created, recipient_note, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${i.docDate}, ${i.invoiceId}, ${i.autoCreated ?? false}, ${i.recipientNote ?? null}, ${who.userId}) RETURNING id, draft_ref AS "draftRef", version`;
  let n = 0;
  for (const l of i.lines) {
    n += 1;
    const [sl] = await tx`SELECT 1 FROM sales_lines WHERE id = ${l.salesLineId} AND invoice_id = ${i.invoiceId}`;
    if (!sl) throw badRequest("LINE_NOT_IN_INVOICE");
    await tx`INSERT INTO delivery_lines(company_id, delivery_id, line_no, sales_line_id, qty_base) VALUES (${who.companyId}, ${h!.id}, ${n}, ${l.salesLineId}, ${l.qtyBase})`;
  }
  if (!i.autoCreated) await audit(tx, actor, { action: "delivery.create_draft", entityType: "delivery_note", entityId: h!.id, after: i });
  return h!;
}

export async function deleteDeliveryDraft(tx: Tx, actor: Actor, id: string) {
  const [cur] = await tx`SELECT status FROM delivery_notes WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.status !== "DRAFT") throw conflict("NOT_DRAFT", "الحذف للمسودات فقط");
  await tx`DELETE FROM delivery_lines WHERE delivery_id = ${id}`;
  await tx`DELETE FROM delivery_notes WHERE id = ${id}`;
  await audit(tx, actor, { action: "delivery.delete_draft", entityType: "delivery_note", entityId: id });
}

export async function listDeliveries(tx: Tx) {
  return tx`SELECT dn.id, dn.draft_ref AS "draftRef", dn.doc_no AS "docNo", dn.doc_date::text AS "docDate", si.doc_no AS "invoiceNo", c.name AS "customerName", dn.status, dn.auto_created AS "auto"
    FROM delivery_notes dn JOIN sales_invoices si ON si.id = dn.invoice_id JOIN contacts c ON c.id = si.customer_id ORDER BY dn.doc_date DESC, dn.created_at DESC LIMIT 300`;
}

/** Ownership passes here: stock leaves in FIFO order and COGS is booked at the layers' real cost. */
export async function postDelivery(tx: Tx, who: Principal, actor: Actor, id: string) {
  const [dn] = await tx`SELECT * FROM delivery_notes WHERE id = ${id} FOR UPDATE`;
  if (!dn) throw notFound();
  if (dn.status !== "DRAFT") throw conflict("NOT_DRAFT");
  const [inv] = await tx`SELECT status FROM sales_invoices WHERE id = ${dn.invoice_id} FOR UPDATE`;
  if (inv!.status !== "POSTED") throw conflict("INVOICE_NOT_POSTED");
  const date = dateOf(dn.doc_date);
  const lines = await tx`SELECT dl.*, sl.product_id, sl.location_id, sl.qty_base AS sold FROM delivery_lines dl JOIN sales_lines sl ON sl.id = dl.sales_line_id WHERE dl.delivery_id = ${id} ORDER BY sl.product_id, dl.line_no`;
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'delivery_note', ${yearOf(date)}) AS n`)[0]!.n as string;
  const [invRow] = await tx`SELECT revenue_deferred, doc_date FROM sales_invoices WHERE id = ${dn.invoice_id}`;
  if (date < dateOf(invRow!.doc_date)) throw badRequest("DELIVERY_BEFORE_INVOICE", "تاريخ التسليم قبل تاريخ الفاتورة");
  const inventory = new Map<string, Decimal>(); let cogs = d(0), revNet = d(0), revGross = d(0);
  for (const l of lines) {
    const done = (await tx`SELECT COALESCE(sum(dl.qty_base), 0)::text AS q, COALESCE(sum(dl.revenue_net_base), 0)::text AS rn, COALESCE(sum(dl.revenue_gross_base), 0)::text AS rg FROM delivery_lines dl JOIN delivery_notes n ON n.id = dl.delivery_id WHERE dl.sales_line_id = ${l.sales_line_id} AND n.status = 'POSTED'`)[0]!;
    if (d(done.q).plus(l.qty_base).gt(l.sold)) throw conflict("DELIVERY_EXCEEDS_INVOICED", "الكمية المسلّمة تتجاوز المفوترة");
    const out = await consumeFifo(tx, who.companyId, { productId: l.product_id, locationId: l.location_id, qtyBase: l.qty_base, type: "SALE_OUT", docType: "delivery_note", docId: id, docLineId: l.id, at: new Date(`${date}T12:00:00Z`), onOrBefore: date });
    let rn = d(0), rg = d(0);
    if (invRow!.revenue_deferred) {                                                  // the delivered share of the invoiced value (the last delivery takes the exact remainder)
      const [sl] = await tx`SELECT net_line_base, line_total_base, qty_base FROM sales_lines WHERE id = ${l.sales_line_id}`;
      const last = d(done.q).plus(l.qty_base).eq(l.sold);
      rn = last ? d(sl!.net_line_base).minus(done.rn) : roundMoney(d(sl!.net_line_base).mul(l.qty_base).div(l.sold), "IQD");
      rg = last ? d(sl!.line_total_base).minus(done.rg) : roundMoney(d(sl!.line_total_base).mul(l.qty_base).div(l.sold), "IQD");
      revNet = revNet.plus(rn); revGross = revGross.plus(rg);
    }
    await tx`UPDATE delivery_lines SET cost_base = ${out.cost.toString()}, revenue_net_base = ${rn.toString()}, revenue_gross_base = ${rg.toString()} WHERE id = ${l.id}`;
    const acct = await inventoryAccountOf(tx, l.location_id);
    inventory.set(acct, (inventory.get(acct) ?? d(0)).plus(out.cost)); cogs = cogs.plus(out.cost);
  }
  const jl: JLine[] = [];
  if (revNet.gt(0) || revGross.gt(0)) { jl.push({ account: "2600", debit: revNet }); if (revGross.minus(revNet).gt(0)) jl.push({ account: "4150", debit: revGross.minus(revNet) }); jl.push({ account: "4100", credit: revGross }); }
  if (cogs.gt(0)) jl.push({ account: "5100", debit: cogs }, ...[...inventory].map(([account, v]): JLine => ({ account, credit: v })));
  const je = jl.length ? await postJournal(tx, actor, { date, sourceDocType: "delivery_note", sourceDocId: id, memo: `سند تسليم ${docNo} — ${revGross.gt(0) ? "إثبات الإيراد وتكلفة البضاعة المباعة" : "تكلفة البضاعة المباعة"}`, lines: jl }) : null;
  const [h] = await tx`UPDATE delivery_notes SET status = 'POSTED', doc_no = ${docNo}, posted_by = ${who.userId}, posted_at = now(), journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, doc_no AS "docNo", status`;
  await audit(tx, actor, { action: "delivery.post", entityType: "delivery_note", entityId: id, after: { docNo, cogs: cogs.toString() } });
  return { ...(h as Record<string, any>), cogsBase: cogs.toString() } as Record<string, any>;
}

export async function reverseDeliveryCore(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [dn] = await tx`SELECT * FROM delivery_notes WHERE id = ${id} FOR UPDATE`;
  if (!dn) throw notFound();
  if (dn.status !== "POSTED") throw conflict("NOT_POSTED");
  if ((await tx`SELECT 1 FROM stock_lot_returns r JOIN sales_returns sr ON sr.id = r.return_id JOIN delivery_lines dl ON dl.id = r.delivery_line_id WHERE dl.delivery_id = ${id} AND sr.status = 'POSTED' LIMIT 1`).length)
    throw conflict("HAS_RETURNS", "يوجد مرتجع على هذا التسليم؛ اعكسه أولاً");
  await restoreConsumptions(tx, who.companyId, "delivery_note", id, new Date());
  if (dn.journal_entry_id) await reverseEntry(tx, actor, dn.journal_entry_id, new Date().toISOString().slice(0, 10), `عكس سند تسليم ${dn.doc_no}: ${reason}`);
  await tx`UPDATE delivery_notes SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "delivery.reverse", entityType: "delivery_note", entityId: id, reason });
  return { id, status: "REVERSED" };
}

// =========================== sales returns ===========================
export const salesReturnSchema = z.object({
  invoiceId: uuid, docDate: dateStr, reason: z.string().min(3).max(500), settlement: z.enum(["REDUCE_RECEIVABLE", "CASH_REFUND"]), cashAccountId: uuid.nullish(),
  lines: z.array(z.object({ salesLineId: uuid, qtyBase: qtyStr })).min(1).max(100),
});

export async function createSalesReturn(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof salesReturnSchema>) {
  const [inv] = await tx`SELECT status, currency FROM sales_invoices WHERE id = ${i.invoiceId}`;
  if (!inv || inv.status !== "POSTED") throw conflict("INVOICE_NOT_POSTED", "المرتجع على فاتورة مرحّلة فقط");
  if (i.settlement === "CASH_REFUND") {
    const [c] = await tx`SELECT currency FROM cash_accounts WHERE id = ${i.cashAccountId ?? null} AND is_active`;
    if (!c || c.currency !== inv.currency) throw badRequest("CASH_CURRENCY_MISMATCH", "حدد صندوقاً بعملة الفاتورة للاسترداد النقدي");
  }
  const ids = i.lines.map((l) => l.salesLineId);
  if ((await tx`SELECT id FROM sales_lines WHERE invoice_id = ${i.invoiceId} AND id IN ${tx(ids)}`).length !== new Set(ids).size) throw badRequest("LINE_NOT_IN_INVOICE");
  const [h] = await tx`INSERT INTO sales_returns(company_id, draft_ref, doc_date, invoice_id, reason, settlement, cash_account_id, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${i.docDate}, ${i.invoiceId}, ${i.reason}, ${i.settlement}, ${i.settlement === "CASH_REFUND" ? i.cashAccountId! : null}, ${who.userId}) RETURNING id, draft_ref AS "draftRef", version`;
  let n = 0;
  for (const l of i.lines) { n += 1; await tx`INSERT INTO sales_return_lines(company_id, return_id, line_no, sales_line_id, qty_base) VALUES (${who.companyId}, ${h!.id}, ${n}, ${l.salesLineId}, ${l.qtyBase})`; }
  await audit(tx, actor, { action: "sales_return.create_draft", entityType: "sales_return", entityId: h!.id, after: i });
  return h!;
}

export async function deleteSalesReturnDraft(tx: Tx, actor: Actor, id: string) {
  const [cur] = await tx`SELECT status FROM sales_returns WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.status !== "DRAFT") throw conflict("NOT_DRAFT", "الحذف للمسودات فقط");
  await tx`DELETE FROM sales_return_lines WHERE return_id = ${id}`;
  await tx`DELETE FROM sales_returns WHERE id = ${id}`;
  await audit(tx, actor, { action: "sales_return.delete_draft", entityType: "sales_return", entityId: id });
}

export async function listSalesReturns(tx: Tx) {
  return tx`SELECT r.id, r.draft_ref AS "draftRef", r.doc_no AS "docNo", r.doc_date::text AS "docDate", si.doc_no AS "invoiceNo", r.settlement, r.status, r.value_base::text AS "valueBase"
    FROM sales_returns r JOIN sales_invoices si ON si.id = r.invoice_id ORDER BY r.doc_date DESC, r.created_at DESC LIMIT 200`;
}

/**
 * A return (1) books the sales reduction in 4190, (2) puts stock back into the ORIGINAL layers at the ORIGINAL cost and reverses that COGS,
 * (3) settles the money: first against what the customer still owes, the excess becomes customer credit (2400) or a cash refund.
 */
export async function postSalesReturn(tx: Tx, who: Principal, actor: Actor, id: string) {
  const [r] = await tx`SELECT * FROM sales_returns WHERE id = ${id} FOR UPDATE`;
  if (!r) throw notFound();
  if (r.status !== "DRAFT") throw conflict("NOT_DRAFT");
  const [inv] = await tx`SELECT * FROM sales_invoices WHERE id = ${r.invoice_id} FOR UPDATE`;
  if (inv!.status !== "POSTED") throw conflict("INVOICE_NOT_POSTED");
  const fin = await invoiceFinancials(tx, inv!.id);
  const date = dateOf(r.doc_date), fx = inv!.exchange_rate_snapshot as string, cur = inv!.currency as string;
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'sales_return', ${yearOf(date)}) AS n`)[0]!.n as string;
  const lines = await tx`SELECT * FROM sales_return_lines WHERE return_id = ${id} ORDER BY line_no`;
  let valO = d(0), valB = d(0), cost = d(0); const invByAcct = new Map<string, Decimal>();
  for (const l of lines) {
    const [sl] = await tx`SELECT * FROM sales_lines WHERE id = ${l.sales_line_id}`;
    const delivered = d((await tx`SELECT COALESCE(sum(dl.qty_base), 0)::text AS q FROM delivery_lines dl JOIN delivery_notes n ON n.id = dl.delivery_id WHERE dl.sales_line_id = ${sl!.id} AND n.status = 'POSTED'`)[0]!.q);
    const prev = (await tx`SELECT COALESCE(sum(rl.qty_base), 0)::text AS q, COALESCE(sum(rl.value_orig), 0)::text AS vo, COALESCE(sum(rl.value_base), 0)::text AS vb FROM sales_return_lines rl JOIN sales_returns x ON x.id = rl.return_id WHERE rl.sales_line_id = ${sl!.id} AND x.status = 'POSTED'`)[0]!;
    const want = d(l.qty_base);
    if (d(prev.q).plus(want).gt(delivered)) throw conflict("RETURN_EXCEEDS_DELIVERED", `الكمية المرتجعة الكلية تتجاوز المسلّم (${delivered})`);
    const rest = d(sl!.qty_base).minus(prev.q);
    const vO = want.eq(rest) ? d(sl!.net_line_orig).minus(prev.vo) : roundMoney(d(sl!.net_line_orig).mul(want).div(sl!.qty_base), cur);
    const vB = want.eq(rest) ? d(sl!.net_line_base).minus(prev.vb) : roundMoney(d(sl!.net_line_base).mul(want).div(sl!.qty_base), "IQD");
    const back = await restoreForReturn(tx, who.companyId, { salesLineId: sl!.id, qtyBase: want, returnId: id, at: new Date(`${date}T12:00:00Z`) });
    await tx`UPDATE sales_return_lines SET value_orig = ${vO.toString()}, value_base = ${vB.toString()}, cost_base = ${back.cost.toString()} WHERE id = ${l.id}`;
    for (const [loc, c] of back.byLocation) { const a = await inventoryAccountOf(tx, loc); invByAcct.set(a, (invByAcct.get(a) ?? d(0)).plus(c)); }
    valO = valO.plus(vO); valB = valB.plus(vB); cost = cost.plus(back.cost);
  }
  const applied = Decimal.min(valO, fin.outstanding), excess = valO.minus(applied);
  const appliedB = valO.gt(0) ? roundMoney(valB.mul(applied).div(valO), "IQD") : d(0), excessB = valB.minus(appliedB);
  const jl: JLine[] = [{ account: "4190", debit: valB, currency: cur, amountOrig: valO, fx }];
  if (applied.gt(0)) jl.push({ account: "1200", credit: appliedB, currency: cur, amountOrig: applied, fx, contactId: inv!.customer_id });
  let refund = d(0), credit = d(0);
  if (excess.gt(0)) {
    if (r.settlement === "CASH_REFUND") {
      refund = excess; await assertCashAvailable(tx, r.cash_account_id, excess); const [ca] = await tx`SELECT ca.id, a.code FROM cash_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = ${r.cash_account_id}`;
      jl.push({ account: ca!.code, credit: excessB, currency: cur, amountOrig: excess, fx });
      await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${who.companyId}, ${ca!.id}, ${excess.neg().toString()}, ${excessB.neg().toString()}, 'sales_return', ${id})`;
    } else { credit = excess; jl.push({ account: "2400", credit: excessB, currency: cur, amountOrig: excess, fx, contactId: inv!.customer_id }); }
  }
  if (cost.gt(0)) { for (const [account, v] of invByAcct) jl.push({ account, debit: v }); jl.push({ account: "5100", credit: cost }); }
  const je = await postJournal(tx, actor, { date, sourceDocType: "sales_return", sourceDocId: id, memo: `مرتجع مبيعات ${docNo}`, lines: jl });
  const [h] = await tx`UPDATE sales_returns SET status = 'POSTED', doc_no = ${docNo}, value_orig = ${valO.toString()}, value_base = ${valB.toString()}, applied_orig = ${applied.toString()}, credit_orig = ${credit.toString()},
      refund_orig = ${refund.toString()}, cogs_base = ${cost.toString()}, posted_by = ${who.userId}, posted_at = now(), journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, doc_no AS "docNo", status`;
  await audit(tx, actor, { action: "sales_return.post", entityType: "sales_return", entityId: id, after: { docNo, valueBase: valB.toString(), cogsBase: cost.toString(), credit: credit.toString(), refund: refund.toString() } });
  return { ...h!, valueBase: valB.toString(), cogsBase: cost.toString(), appliedToReceivable: applied.toString(), customerCredit: credit.toString(), cashRefund: refund.toString() };
}

export async function reverseSalesReturn(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [r] = await tx`SELECT * FROM sales_returns WHERE id = ${id} FOR UPDATE`;
  if (!r) throw notFound();
  if (r.status !== "POSTED") throw conflict("NOT_POSTED");
  await undoReturnRestock(tx, who.companyId, id, new Date());
  await reverseEntry(tx, actor, r.journal_entry_id, new Date().toISOString().slice(0, 10), `عكس مرتجع ${r.doc_no}: ${reason}`);
  if (d(r.refund_orig).gt(0)) await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id)
    SELECT company_id, cash_account_id, abs(amount), abs(amount_base), 'sales_return', doc_id FROM cash_movements WHERE doc_type = 'sales_return' AND doc_id = ${id} AND amount < 0`;
  await tx`UPDATE sales_returns SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "sales_return.reverse", entityType: "sales_return", entityId: id, reason });
  return { id, status: "REVERSED" };
}

// =========================== quotes ===========================
export const quoteSchema = z.object({
  customerId: uuid, docDate: dateStr, validUntil: dateStr.nullish(), currency: currencyCode, exchangeRate: rateStr.nullish(), discount: moneyStr.default("0"),
  terms: z.string().max(1000).nullish(), notes: z.string().max(1000).nullish(),
  lines: z.array(z.object({ productId: uuid, uom: z.string().min(1).max(30), qty: qtyStr, unitPrice: moneyStr, lineDiscount: moneyStr.default("0") })).min(1).max(200),
});
export const quoteUpdateSchema = quoteSchema.extend({ version: z.number().int() });

async function prepareQuote(tx: Tx, i: z.infer<typeof quoteSchema>) {
  const [c] = await tx`SELECT kind, is_archived FROM contacts WHERE id = ${i.customerId}`;
  if (!c || c.kind === "SUPPLIER") throw badRequest("NOT_A_CUSTOMER");
  const rate = await resolveRate(tx, i.currency, i.docDate, i.exchangeRate ?? undefined);
  const lines = [];
  for (const l of i.lines) {
    await toBaseQty(tx, l.productId, l.uom, l.qty);
    const t = roundMoney(d(l.qty).mul(l.unitPrice).minus(l.lineDiscount), i.currency);
    if (t.lt(0)) throw badRequest("DISCOUNT_EXCEEDS_LINE");
    lines.push({ ...l, lineTotal: t.toString() });
  }
  const gross = lines.reduce((s, l) => s.plus(l.lineTotal), d(0)), disc = roundMoney(i.discount, i.currency);
  if (disc.gt(gross)) throw badRequest("DISCOUNT_EXCEEDS_TOTAL");
  return { rate, lines, disc, total: gross.minus(disc) };
}
async function writeQuoteLines(tx: Tx, companyId: string, id: string, lines: Awaited<ReturnType<typeof prepareQuote>>["lines"]) {
  await tx`DELETE FROM sales_quote_lines WHERE quote_id = ${id}`;
  let n = 0;
  for (const l of lines) { n += 1; await tx`INSERT INTO sales_quote_lines(company_id, quote_id, line_no, product_id, uom, qty, unit_price, line_discount, line_total) VALUES (${companyId}, ${id}, ${n}, ${l.productId}, ${l.uom}, ${l.qty}, ${l.unitPrice}, ${l.lineDiscount}, ${l.lineTotal})`; }
}
export async function createQuote(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof quoteSchema>) {
  const p = await prepareQuote(tx, i);
  const [h] = await tx`INSERT INTO sales_quotes(company_id, draft_ref, doc_date, valid_until, customer_id, currency, exchange_rate_snapshot, discount, total, terms, notes, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${i.docDate}, ${i.validUntil ?? null}, ${i.customerId}, ${i.currency}, ${p.rate}, ${p.disc.toString()}, ${p.total.toString()}, ${i.terms ?? null}, ${i.notes ?? null}, ${who.userId}) RETURNING id, draft_ref AS "draftRef", version`;
  await writeQuoteLines(tx, who.companyId, h!.id, p.lines);
  await audit(tx, actor, { action: "sales_quote.create_draft", entityType: "sales_quote", entityId: h!.id, after: { total: p.total.toString() } });
  return h!;
}
export async function updateQuote(tx: Tx, who: Principal, actor: Actor, id: string, i: z.infer<typeof quoteUpdateSchema>) {
  const [cur] = await tx`SELECT status, version FROM sales_quotes WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.status !== "DRAFT") throw conflict("NOT_DRAFT", "العرض صادر ولا يُعدَّل");
  if (cur.version !== i.version) throw conflict("VERSION_CONFLICT");
  const p = await prepareQuote(tx, i);
  await writeQuoteLines(tx, who.companyId, id, p.lines);
  const [h] = await tx`UPDATE sales_quotes SET doc_date = ${i.docDate}, valid_until = ${i.validUntil ?? null}, customer_id = ${i.customerId}, currency = ${i.currency}, exchange_rate_snapshot = ${p.rate},
      discount = ${p.disc.toString()}, total = ${p.total.toString()}, terms = ${i.terms ?? null}, notes = ${i.notes ?? null}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, version`;
  await audit(tx, actor, { action: "sales_quote.update_draft", entityType: "sales_quote", entityId: id });
  return h!;
}
export async function issueQuote(tx: Tx, who: Principal, actor: Actor, id: string) {
  const [q] = await tx`SELECT * FROM sales_quotes WHERE id = ${id} FOR UPDATE`;
  if (!q) throw notFound();
  if (q.status !== "DRAFT") throw conflict("NOT_DRAFT");
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'sales_quote', ${yearOf(dateOf(q.doc_date))}) AS n`)[0]!.n as string;
  const [h] = await tx`UPDATE sales_quotes SET status = 'SENT', doc_no = ${docNo}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, doc_no AS "docNo", status`;
  await audit(tx, actor, { action: "sales_quote.issue", entityType: "sales_quote", entityId: id, after: { docNo } });
  return h!;
}
export async function setQuoteStatus(tx: Tx, actor: Actor, id: string, status: "ACCEPTED" | "REJECTED" | "EXPIRED") {
  const [q] = await tx`SELECT status FROM sales_quotes WHERE id = ${id} FOR UPDATE`;
  if (!q) throw notFound();
  if (q.status !== "SENT" && !(q.status === "ACCEPTED" && status === "EXPIRED")) throw conflict("BAD_STATE", "تغيير الحالة غير مسموح");
  await tx`UPDATE sales_quotes SET status = ${status}, version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: `sales_quote.${status.toLowerCase()}`, entityType: "sales_quote", entityId: id });
  return { id, status };
}
export async function deleteQuoteDraft(tx: Tx, actor: Actor, id: string) {
  const [q] = await tx`SELECT status FROM sales_quotes WHERE id = ${id} FOR UPDATE`;
  if (!q) throw notFound();
  if (q.status !== "DRAFT") throw conflict("NOT_DRAFT", "الحذف للمسودات فقط");
  await tx`DELETE FROM sales_quote_lines WHERE quote_id = ${id}`;
  await tx`DELETE FROM sales_quotes WHERE id = ${id}`;
  await audit(tx, actor, { action: "sales_quote.delete_draft", entityType: "sales_quote", entityId: id });
}
export async function listQuotes(tx: Tx) {
  return tx`SELECT q.id, q.draft_ref AS "draftRef", q.doc_no AS "docNo", q.doc_date::text AS "docDate", q.valid_until::text AS "validUntil", c.name AS "customerName", q.currency, q.total::text AS total, q.status, q.invoice_id AS "invoiceId"
    FROM sales_quotes q JOIN contacts c ON c.id = q.customer_id ORDER BY q.doc_date DESC, q.created_at DESC LIMIT 300`;
}
export async function getQuote(tx: Tx, id: string): Promise<Record<string, any>> {
  const [h] = await tx`SELECT q.id, q.draft_ref AS "draftRef", q.doc_no AS "docNo", q.doc_date::text AS "docDate", q.valid_until::text AS "validUntil", q.customer_id AS "customerId", c.name AS "customerName", c.phones AS "customerPhones", c.address AS "customerAddress",
      q.currency, q.exchange_rate_snapshot::text AS "exchangeRate", q.discount::text AS discount, q.total::text AS total, q.terms, q.notes, q.status, q.version, q.invoice_id AS "invoiceId"
    FROM sales_quotes q JOIN contacts c ON c.id = q.customer_id WHERE q.id = ${id}`;
  if (!h) throw notFound();
  const lines = await tx`SELECT l.id, l.line_no AS "lineNo", l.product_id AS "productId", p.code AS "productCode", p.name AS "productName", l.uom, l.qty::text, l.unit_price::text AS "unitPrice", l.line_discount::text AS "lineDiscount", l.line_total::text AS "lineTotal"
    FROM sales_quote_lines l JOIN products p ON p.id = l.product_id WHERE l.quote_id = ${id} ORDER BY l.line_no`;
  return { ...(h as Record<string, any>), lines } as Record<string, any>;
}
/** Accepted/sent quote -> invoice DRAFT (cash/credit, delivery mode and dates are chosen on the draft). */
export async function convertQuote(tx: Tx, who: Principal, actor: Actor, id: string, o: { saleType: "CASH" | "CREDIT"; cashAccountId?: string | null; docDate: string }) {
  const q = await getQuote(tx, id);
  if (!["SENT", "ACCEPTED"].includes(q.status)) throw conflict("BAD_STATE", "يُحوَّل العرض الصادر أو المقبول فقط");
  if (q.invoiceId) throw conflict("ALREADY_CONVERTED");
  const inv = await createInvoice(tx, who, actor, { customerId: q.customerId, docDate: o.docDate, saleType: o.saleType, cashAccountId: o.cashAccountId ?? null, currency: q.currency as "IQD" | "USD", exchangeRate: q.currency === "IQD" ? null : q.exchangeRate,
    deliveryMode: "WITH_INVOICE", discount: q.discount, terms: q.terms, notes: q.notes, quoteId: id,
    lines: q.lines.map((l: any) => ({ productId: l.productId, uom: l.uom, qty: l.qty, unitPrice: l.unitPrice, lineDiscount: l.lineDiscount })) });
  await tx`UPDATE sales_quotes SET status = 'CONVERTED', invoice_id = ${inv.id}, version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "sales_quote.convert", entityType: "sales_quote", entityId: id, after: { invoiceId: inv.id } });
  return inv;
}
void forbidden;

export async function getDelivery(tx: Tx, id: string) {
  const [h] = await tx`SELECT dn.id, dn.doc_no AS "docNo", dn.draft_ref AS "draftRef", dn.doc_date::text AS "docDate", si.doc_no AS "invoiceNo", c.name AS "customerName", c.phones AS "customerPhones", c.address AS "customerAddress", dn.recipient_note AS "recipientNote", dn.status
    FROM delivery_notes dn JOIN sales_invoices si ON si.id = dn.invoice_id JOIN contacts c ON c.id = si.customer_id WHERE dn.id = ${id}`;
  if (!h) throw notFound();
  const lines = await tx`SELECT p.code AS "productCode", p.name AS "productName", sl.uom, dl.qty_base::text AS "qtyBase" FROM delivery_lines dl JOIN sales_lines sl ON sl.id = dl.sales_line_id JOIN products p ON p.id = sl.product_id WHERE dl.delivery_id = ${id} ORDER BY dl.line_no`;
  return { ...h, lines };
}
