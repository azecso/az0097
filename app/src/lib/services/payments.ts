import { z } from "zod";
import Decimal from "decimal.js";
import type { Tx } from "../db";
import { reverseCashMovements } from "./cash";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, conflict, notFound } from "../errors";
import { d, roundMoney, toBase } from "../money";
import { postJournal, reverseEntry, type JLine } from "../ledger";
import { currencyCode, dateStr, draftRef, moneyStr, rateStr, resolveRate, uuid, yearOf } from "./common";
import { purchaseOutstanding } from "./purchases";
import { assertCashAvailable } from "./cash";

export const paymentSchema = z.object({
  supplierId: uuid, docDate: dateStr, cashAccountId: uuid, currency: currencyCode, exchangeRate: rateStr.nullish(), amount: moneyStr, notes: z.string().max(500).nullish(),
  allocations: z.array(z.object({ purchaseId: uuid, amount: moneyStr })).max(100).default([]),
});

async function check(tx: Tx, i: z.infer<typeof paymentSchema>, excludePaymentId?: string) {
  const amount = d(i.amount);
  if (amount.lte(0)) throw badRequest("INVALID_AMOUNT");
  const [c] = await tx`SELECT currency, kind FROM cash_accounts WHERE id = ${i.cashAccountId} AND is_active`;
  if (!c || c.kind === "PARTNER_CUSTODY") throw badRequest("BAD_CASH_ACCOUNT");
  if (c.currency !== i.currency) throw badRequest("CASH_CURRENCY_MISMATCH", "عملة الصندوق يجب أن تطابق عملة الدفعة");
  const [s] = await tx`SELECT kind FROM contacts WHERE id = ${i.supplierId}`;
  if (!s || s.kind === "CUSTOMER") throw badRequest("NOT_A_SUPPLIER");
  let alloc = d(0);
  for (const a of i.allocations) {
    const [p] = await tx`SELECT supplier_id, status, currency, payment_type FROM purchase_orders WHERE id = ${a.purchaseId}`;
    if (!p || p.supplier_id !== i.supplierId || p.status !== "POSTED" || p.payment_type !== "CREDIT") throw badRequest("BAD_ALLOCATION", "التخصيص على فاتورة آجلة مرحّلة لنفس المورد فقط");
    if (p.currency !== i.currency) throw badRequest("ALLOCATION_CURRENCY_MISMATCH", "عملة الفاتورة تخالف عملة الدفعة");
    if (d(a.amount).gt((await purchaseOutstanding(tx, a.purchaseId)).outstanding)) throw conflict("OVER_ALLOCATION", "المبلغ المخصص يتجاوز المستحق على الفاتورة");
    alloc = alloc.plus(a.amount);
  }
  if (alloc.gt(amount)) throw badRequest("ALLOCATIONS_EXCEED_AMOUNT", "مجموع التخصيصات أكبر من مبلغ الدفعة");
  void excludePaymentId;
}

async function writeAllocs(tx: Tx, companyId: string, id: string, allocs: z.infer<typeof paymentSchema>["allocations"]) {
  await tx`DELETE FROM supplier_payment_allocations WHERE payment_id = ${id}`;
  for (const a of allocs) await tx`INSERT INTO supplier_payment_allocations(company_id, payment_id, purchase_id, amount) VALUES (${companyId}, ${id}, ${a.purchaseId}, ${a.amount})`;
}

export async function createPayment(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof paymentSchema>) {
  await check(tx, i);
  const rate = await resolveRate(tx, i.currency, i.docDate, i.exchangeRate ?? undefined);
  const [p] = await tx`INSERT INTO supplier_payments(company_id, draft_ref, doc_date, supplier_id, cash_account_id, currency, exchange_rate_snapshot, amount, notes, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${i.docDate}, ${i.supplierId}, ${i.cashAccountId}, ${i.currency}, ${rate}, ${i.amount}, ${i.notes ?? null}, ${who.userId}) RETURNING id, draft_ref AS "draftRef", version`;
  await writeAllocs(tx, who.companyId, p!.id, i.allocations);
  await audit(tx, actor, { action: "supplier_payment.create_draft", entityType: "supplier_payment", entityId: p!.id, after: { amount: i.amount, currency: i.currency } });
  return p!;
}

export async function deletePaymentDraft(tx: Tx, actor: Actor, id: string) {
  const [cur] = await tx`SELECT status FROM supplier_payments WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.status !== "DRAFT") throw conflict("NOT_DRAFT", "الحذف للمسودات فقط");
  await tx`DELETE FROM supplier_payment_allocations WHERE payment_id = ${id}`;
  await tx`DELETE FROM supplier_payments WHERE id = ${id}`;
  await audit(tx, actor, { action: "supplier_payment.delete_draft", entityType: "supplier_payment", entityId: id });
}

export async function listPayments(tx: Tx) {
  return tx`SELECT sp.id, sp.draft_ref AS "draftRef", sp.doc_no AS "docNo", sp.doc_date::text AS "docDate", c.name AS "supplierName", sp.currency, sp.amount::text AS amount, sp.status, sp.fx_diff_base::text AS "fxDiffBase"
    FROM supplier_payments sp JOIN contacts c ON c.id = sp.supplier_id ORDER BY sp.doc_date DESC, sp.created_at DESC LIMIT 300`;
}

/**
 * Posting a payment: Dr AP at the ORIGINAL invoice rate for the allocated part (unallocated part = supplier advance at today's rate),
 * Cr cash at the PAYMENT rate; the difference is the realised FX gain/loss in 7100. Never an operating expense.
 */
export async function postPayment(tx: Tx, who: Principal, actor: Actor, id: string) {
  const [p] = await tx`SELECT * FROM supplier_payments WHERE id = ${id} FOR UPDATE`;
  if (!p) throw notFound();
  if (p.status !== "DRAFT") throw conflict("NOT_DRAFT");
  const allocs = await tx`SELECT a.purchase_id, a.amount::text, po.exchange_rate_snapshot::text AS fx FROM supplier_payment_allocations a JOIN purchase_orders po ON po.id = a.purchase_id WHERE a.payment_id = ${id}`;
  await check(tx, { supplierId: p.supplier_id, docDate: String(p.doc_date), cashAccountId: p.cash_account_id, currency: p.currency, amount: p.amount,
    allocations: allocs.map((a) => ({ purchaseId: a.purchase_id, amount: a.amount })) } as z.infer<typeof paymentSchema>);
  const date = p.doc_date instanceof Date ? p.doc_date.toISOString().slice(0, 10) : String(p.doc_date);
  const fx = p.exchange_rate_snapshot as string, cur = p.currency as string;
  const docNo = (p.doc_no as string | null) ?? (await tx`SELECT next_document_number(${who.companyId}, 'supplier_payment', ${yearOf(date)}) AS n`)[0]!.n as string;   // an amended payment keeps its number
  let apBase = d(0), allocated = d(0);
  for (const a of allocs) { apBase = apBase.plus(toBase(a.amount, a.fx, cur)); allocated = allocated.plus(a.amount); }
  const advance = d(p.amount).minus(allocated);
  if (advance.gt(0)) apBase = apBase.plus(toBase(advance, fx, cur));
  const cashBase = toBase(p.amount, fx, cur), fxDiff = cashBase.minus(apBase);   // + = paid more dinars than booked (loss)
  await assertCashAvailable(tx, p.cash_account_id, p.amount);
  const [ca] = await tx`SELECT ca.id, a.code FROM cash_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = ${p.cash_account_id}`;
  const jl: JLine[] = [{ account: "2100", debit: apBase, currency: cur, amountOrig: p.amount, fx, contactId: p.supplier_id },
    { account: ca!.code, credit: cashBase, currency: cur, amountOrig: p.amount, fx }];
  if (fxDiff.gt(0)) jl.push({ account: "7100", debit: fxDiff, memo: "خسارة فرق صرف محققة" });
  if (fxDiff.lt(0)) jl.push({ account: "7100", credit: fxDiff.abs(), memo: "ربح فرق صرف محقق" });
  const je = await postJournal(tx, actor, { date, sourceDocType: "supplier_payment", sourceDocId: id, memo: `سند صرف ${docNo}`, lines: jl });
  await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${who.companyId}, ${ca!.id}, ${d(p.amount).neg().toString()}, ${cashBase.neg().toString()}, 'supplier_payment', ${id})`;
  const [h] = await tx`UPDATE supplier_payments SET status = 'POSTED', doc_no = ${docNo}, amount_base = ${cashBase.toString()}, fx_diff_base = ${fxDiff.toString()}, posted_by = ${who.userId}, posted_at = now(),
      journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, doc_no AS "docNo", status, fx_diff_base::text AS "fxDiffBase"`;
  await audit(tx, actor, { action: "supplier_payment.post", entityType: "supplier_payment", entityId: id, after: { docNo, fxDiff: fxDiff.toString() } });
  return h!;
}

export async function reversePayment(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [p] = await tx`SELECT * FROM supplier_payments WHERE id = ${id} FOR UPDATE`;
  if (!p) throw notFound();
  if (p.status !== "POSTED") throw conflict("NOT_POSTED");
  await reverseEntry(tx, actor, p.journal_entry_id, new Date().toISOString().slice(0, 10), `عكس سند صرف ${p.doc_no}: ${reason}`);
  await reverseCashMovements(tx, "supplier_payment", id);
  await tx`UPDATE supplier_payments SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "supplier_payment.reverse", entityType: "supplier_payment", entityId: id, reason });
  return { id, status: "REVERSED" };
}
void Decimal; void roundMoney;

/** Internal: POSTED -> DRAFT keeping the number; the journal entry and the cash movement are reversed (append-only), nothing is deleted. */
export async function unpostPayment(tx: Tx, actor: Actor, id: string, reason: string) {
  const [p] = await tx`SELECT * FROM supplier_payments WHERE id = ${id} FOR UPDATE`;
  if (!p || p.status !== "POSTED") throw conflict("NOT_POSTED");
  await reverseEntry(tx, actor, p.journal_entry_id, new Date().toISOString().slice(0, 10), `${reason} ${p.doc_no}`);
  await reverseCashMovements(tx, "supplier_payment", id);
  await tx`SELECT set_config('app.amend', 'on', true)`;
  await tx`UPDATE supplier_payments SET status = 'DRAFT', version = version + 1, updated_at = now() WHERE id = ${id}`;
}
export const paymentUpdateSchema = paymentSchema.extend({ version: z.number().int() });
/** Edit a POSTED payment voucher keeping its number: amount, date, cash account, allocation, currency/rate. One effective voucher; the old figures stay in the ledger and audit log. */
export async function amendPayment(tx: Tx, who: Principal, actor: Actor, id: string, i: z.infer<typeof paymentUpdateSchema>) {
  const [p] = await tx`SELECT * FROM supplier_payments WHERE id = ${id} FOR UPDATE`;
  if (!p) throw notFound();
  if (p.status !== "POSTED") throw conflict("NOT_POSTED", "التعديل بهذه الطريقة للسندات المرحّلة فقط");
  if (p.version !== i.version) throw conflict("VERSION_CONFLICT", "تم تعديل السند من جهة أخرى؛ أعد فتحه");
  await unpostPayment(tx, actor, id, "تعديل سند صرف");
  await check(tx, i);
  const rate = await resolveRate(tx, i.currency, i.docDate, i.exchangeRate ?? undefined);
  await tx`UPDATE supplier_payments SET doc_date = ${i.docDate}, supplier_id = ${i.supplierId}, cash_account_id = ${i.cashAccountId}, currency = ${i.currency}, exchange_rate_snapshot = ${rate}, amount = ${i.amount}, notes = ${i.notes ?? null}, updated_at = now() WHERE id = ${id}`;
  await writeAllocs(tx, who.companyId, id, i.allocations);
  const h = await postPayment(tx, who, actor, id);
  await audit(tx, actor, { action: "supplier_payment.amend", entityType: "supplier_payment", entityId: id, before: { amount: p.amount, docNo: p.doc_no }, after: { amount: i.amount } });
  return h;
}
/** The editable form of a posted payment: each invoice with what is still owed WITHOUT this payment. */
export async function getPaymentForEdit(tx: Tx, id: string) {
  const [p] = await tx`SELECT id, doc_no AS "docNo", doc_date::text AS "docDate", supplier_id AS "supplierId", cash_account_id AS "cashAccountId", currency, exchange_rate_snapshot::text AS "exchangeRate", amount::text AS amount, notes, status, version FROM supplier_payments WHERE id = ${id}`;
  if (!p) throw notFound();
  const rows = await tx`SELECT po.id AS "purchaseId", po.doc_no AS "docNo", po.currency, a.amount::text AS paid FROM supplier_payment_allocations a JOIN purchase_orders po ON po.id = a.purchase_id WHERE a.payment_id = ${id} ORDER BY po.doc_date, po.doc_no`;
  const allocations = [];
  for (const x of rows) allocations.push({ ...x, outstandingWithout: d((await purchaseOutstanding(tx, x.purchaseId as string)).outstanding).plus(p.status === "POSTED" ? (x.paid as string) : 0).toString() });
  return { ...p, allocations };
}

export async function getSupplierPayment(tx: Tx, id: string) {
  const [p] = await tx`SELECT sp.id, sp.doc_no AS "docNo", sp.draft_ref AS "draftRef", sp.doc_date::text AS "docDate", c.name AS "supplierName", c.phones AS "supplierPhones", c.address AS "supplierAddress", ca.name AS "cashAccount", sp.currency, sp.exchange_rate_snapshot::text AS "exchangeRate",
      sp.amount::text AS amount, sp.notes, sp.status FROM supplier_payments sp JOIN contacts c ON c.id = sp.supplier_id JOIN cash_accounts ca ON ca.id = sp.cash_account_id WHERE sp.id = ${id}`;
  if (!p) throw notFound();
  // Per purchase invoice: its value, what this payment pays, what has been paid up to and including this payment, and what is STILL owed after it.
  const rows = await tx`SELECT po.doc_no AS "purchaseNo", po.total::text AS "invoiceTotal", a.amount::text AS amount,
      (COALESCE((SELECT sum(a2.amount) FROM supplier_payment_allocations a2 JOIN supplier_payments s2 ON s2.id = a2.payment_id
                 WHERE a2.purchase_id = po.id AND s2.status = 'POSTED' AND s2.id <> ${id}
                   AND s2.posted_at <= COALESCE((SELECT posted_at FROM supplier_payments WHERE id = ${id}), 'infinity'::timestamptz)), 0) + a.amount)::text AS "paidToDate",
      COALESCE((SELECT sum(r.total_orig) FROM purchase_returns r WHERE r.purchase_id = po.id AND r.status = 'POSTED' AND r.settlement = 'REDUCE_PAYABLE'), 0)::text AS returned
    FROM supplier_payment_allocations a JOIN purchase_orders po ON po.id = a.purchase_id WHERE a.payment_id = ${id} ORDER BY po.doc_date, po.doc_no`;
  const allocations = rows.map((x) => { const rem = Decimal.max(d(x.invoiceTotal as string).minus(x.paidToDate as string).minus(x.returned as string), 0);
    return { purchaseNo: x.purchaseNo as string, invoiceTotal: x.invoiceTotal as string, amount: x.amount as string, paidToDate: x.paidToDate as string, returned: x.returned as string, remaining: rem.toString(), state: rem.lte(0) ? "PAID" : "PARTIAL" }; });
  return { ...p, allocations };
}

// =========================== pay from the purchase screen: ONE atomic, idempotent action ===========================
export const payOnPurchaseSchema = z.object({ requestId: z.string().min(8).max(120), docDate: dateStr, cashAccountId: uuid, currency: currencyCode, exchangeRate: rateStr.nullish(), amount: moneyStr, notes: z.string().max(500).nullish() });
/** Create + post the supplier payment allocated to THIS purchase in one transaction; a retry with the same requestId returns the first result. */
export async function payOnPurchase(tx: Tx, who: Principal, actor: Actor, purchaseId: string, i: z.infer<typeof payOnPurchaseSchema>) {
  const { once } = await import("../idempotency");
  return once(tx, who, i.requestId, `pay:${purchaseId}`, async () => {
    const [po] = await tx`SELECT supplier_id, currency, status, payment_type FROM purchase_orders WHERE id = ${purchaseId} FOR UPDATE`;
    if (!po) throw notFound();
    if (po.status !== "POSTED") throw conflict("PURCHASE_NOT_POSTED", "رحّل فاتورة الشراء أولاً");
    if (po.payment_type !== "CREDIT") throw conflict("NOT_CREDIT_PURCHASE", "فاتورة الشراء نقدية؛ لا يوجد مستحق للسداد");
    const out = d((await purchaseOutstanding(tx, purchaseId)).outstanding);
    if (out.lte(0)) throw conflict("ALREADY_SETTLED", "الفاتورة مسدَّدة بالكامل");
    if (po.currency !== i.currency) throw badRequest("CASH_CURRENCY_MISMATCH", `الفاتورة بعملة ${po.currency}؛ اختر صندوقاً بالعملة نفسها`);
    const p = await createPayment(tx, who, actor, { supplierId: po.supplier_id as string, docDate: i.docDate, cashAccountId: i.cashAccountId, currency: i.currency, exchangeRate: i.exchangeRate, amount: i.amount, notes: i.notes ?? null, allocations: [{ purchaseId, amount: i.amount }] });
    const posted = await postPayment(tx, who, actor, p.id as string);
    return { paymentId: p.id as string, docNo: posted.docNo as string, outstanding: (await purchaseOutstanding(tx, purchaseId)).outstanding };
  });
}
