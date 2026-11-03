import { z } from "zod";
import Decimal from "decimal.js";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, conflict, notFound } from "../errors";
import { d, toBase } from "../money";
import { postJournal, reverseEntry, type JLine } from "../ledger";
import { currencyCode, dateStr, draftRef, moneyStr, rateStr, resolveRate, uuid, yearOf } from "./common";
import { invoiceFinancials } from "./sales";
import { assertCashAvailable } from "./cash";

const dateOf = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));

/** Customer credit balance (liability 2400) available to apply, in base currency terms of the ledger. */
export async function customerCredit(tx: Tx, customerId: string) {
  const [r] = await tx`SELECT COALESCE(sum(jl.credit_base - jl.debit_base), 0)::text AS c FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '2400' AND jl.contact_id = ${customerId}`;
  return d(r!.c);
}

// =========================== receipts (سند قبض) ===========================
export const receiptSchema = z.object({
  customerId: uuid, docDate: dateStr, kind: z.enum(["CASH", "CREDIT_APPLICATION"]).default("CASH"), cashAccountId: uuid.nullish(), currency: currencyCode, exchangeRate: rateStr.nullish(),
  amount: moneyStr, notes: z.string().max(500).nullish(), allocations: z.array(z.object({ invoiceId: uuid, amount: moneyStr })).max(100).default([]),
});

async function validate(tx: Tx, i: z.infer<typeof receiptSchema>) {
  const amount = d(i.amount);
  if (amount.lte(0)) throw badRequest("INVALID_AMOUNT");
  const [c] = await tx`SELECT kind FROM contacts WHERE id = ${i.customerId}`;
  if (!c || c.kind === "SUPPLIER") throw badRequest("NOT_A_CUSTOMER");
  if (i.kind === "CASH") {
    const [ca] = await tx`SELECT currency FROM cash_accounts WHERE id = ${i.cashAccountId ?? null} AND is_active`;
    if (!ca) throw badRequest("CASH_ACCOUNT_REQUIRED", "اختر الصندوق أو عهدة الشريك");
    if (ca.currency !== i.currency) throw badRequest("CASH_CURRENCY_MISMATCH", "عملة الصندوق يجب أن تطابق عملة السند");
  }
  let alloc = d(0);
  for (const a of i.allocations) {
    const [inv] = await tx`SELECT customer_id, status, currency FROM sales_invoices WHERE id = ${a.invoiceId}`;
    if (!inv || inv.customer_id !== i.customerId || inv.status !== "POSTED") throw badRequest("BAD_ALLOCATION", "التخصيص على فاتورة مرحّلة لنفس العميل فقط");
    if (inv.currency !== i.currency) throw badRequest("ALLOCATION_CURRENCY_MISMATCH", "عملة الفاتورة تخالف عملة السند");
    if (d(a.amount).gt((await invoiceFinancials(tx, a.invoiceId)).outstanding)) throw conflict("OVER_ALLOCATION", "المبلغ المخصص يتجاوز المتبقي على الفاتورة");
    alloc = alloc.plus(a.amount);
  }
  if (alloc.gt(amount)) throw badRequest("ALLOCATIONS_EXCEED_AMOUNT", "مجموع التخصيصات أكبر من المبلغ");
  if (i.kind === "CREDIT_APPLICATION") {
    if (!alloc.eq(amount)) throw badRequest("CREDIT_MUST_BE_ALLOCATED", "استخدام الرصيد الدائن يجب أن يُخصَّص بالكامل على فواتير");
  }
}

async function writeAllocs(tx: Tx, companyId: string, id: string, allocs: { invoiceId: string; amount: string }[]) {
  await tx`DELETE FROM receipt_allocations WHERE receipt_id = ${id}`;
  for (const a of allocs) await tx`INSERT INTO receipt_allocations(company_id, receipt_id, invoice_id, amount) VALUES (${companyId}, ${id}, ${a.invoiceId}, ${a.amount})`;
}

export async function createReceipt(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof receiptSchema>) {
  await validate(tx, i);
  const rate = await resolveRate(tx, i.currency, i.docDate, i.exchangeRate ?? undefined);
  const [r] = await tx`INSERT INTO customer_receipts(company_id, draft_ref, doc_date, kind, customer_id, cash_account_id, currency, exchange_rate_snapshot, amount, notes, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${i.docDate}, ${i.kind}, ${i.customerId}, ${i.kind === "CASH" ? i.cashAccountId! : null}, ${i.currency}, ${rate}, ${i.amount}, ${i.notes ?? null}, ${who.userId}) RETURNING id, draft_ref AS "draftRef", version`;
  await writeAllocs(tx, who.companyId, r!.id, i.allocations);
  await audit(tx, actor, { action: "receipt.create_draft", entityType: "customer_receipt", entityId: r!.id, after: { amount: i.amount, kind: i.kind } });
  return r!;
}

export async function deleteReceiptDraft(tx: Tx, actor: Actor, id: string) {
  const [cur] = await tx`SELECT status FROM customer_receipts WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.status !== "DRAFT") throw conflict("NOT_DRAFT", "الحذف للمسودات فقط");
  await tx`DELETE FROM receipt_allocations WHERE receipt_id = ${id}`;
  await tx`DELETE FROM customer_receipts WHERE id = ${id}`;
  await audit(tx, actor, { action: "receipt.delete_draft", entityType: "customer_receipt", entityId: id });
}

export async function listReceipts(tx: Tx) {
  return tx`SELECT r.id, r.draft_ref AS "draftRef", r.doc_no AS "docNo", r.doc_date::text AS "docDate", c.name AS "customerName", r.kind, ca.name AS "cashAccount", r.currency, r.amount::text AS amount, r.fx_diff_base::text AS "fxDiffBase", r.status, r.auto_for_invoice_id AS "autoForInvoice"
    FROM customer_receipts r JOIN contacts c ON c.id = r.customer_id LEFT JOIN cash_accounts ca ON ca.id = r.cash_account_id ORDER BY r.doc_date DESC, r.created_at DESC LIMIT 300`;
}

/**
 * CASH receipt: Dr cash (or partner custody 1150) at today's rate; Cr 1200 at each invoice's ORIGINAL rate; unallocated rest => customer credit 2400;
 * the difference is a realised FX gain/loss in 7100. A collection is recorded ONCE here; handing custody cash over later is a transfer, not income.
 */
export async function postReceipt(tx: Tx, who: Principal, actor: Actor, id: string) {
  const [r] = await tx`SELECT * FROM customer_receipts WHERE id = ${id} FOR UPDATE`;
  if (!r) throw notFound();
  if (r.status !== "DRAFT") throw conflict("NOT_DRAFT");
  const allocs = await tx`SELECT a.invoice_id, a.amount::text AS amount, si.exchange_rate_snapshot::text AS fx FROM receipt_allocations a JOIN sales_invoices si ON si.id = a.invoice_id WHERE a.receipt_id = ${id}`;
  await validate(tx, { customerId: r.customer_id, docDate: dateOf(r.doc_date), kind: r.kind, cashAccountId: r.cash_account_id, currency: r.currency, amount: r.amount,
    allocations: allocs.map((a) => ({ invoiceId: a.invoice_id, amount: a.amount })) } as z.infer<typeof receiptSchema>);
  const date = dateOf(r.doc_date), fx = r.exchange_rate_snapshot as string, cur = r.currency as string;
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'customer_receipt', ${yearOf(date)}) AS n`)[0]!.n as string;
  let arBase = d(0), allocated = d(0);
  for (const a of allocs) { arBase = arBase.plus(toBase(a.amount, a.fx, cur)); allocated = allocated.plus(a.amount); }
  const rest = d(r.amount).minus(allocated), creditBase = rest.gt(0) ? toBase(rest, fx, cur) : d(0);
  const jl: JLine[] = []; let cashBase = d(0), fxDiff = d(0);
  if (r.kind === "CASH") {
    cashBase = toBase(r.amount, fx, cur); fxDiff = cashBase.minus(arBase).minus(creditBase);          // + = received more dinars than booked (gain)
    const [ca] = await tx`SELECT ca.id, a.code FROM cash_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = ${r.cash_account_id}`;
    jl.push({ account: ca!.code, debit: cashBase, currency: cur, amountOrig: r.amount, fx });
    if (arBase.gt(0)) jl.push({ account: "1200", credit: arBase, currency: cur, amountOrig: allocated, fx, contactId: r.customer_id });
    if (creditBase.gt(0)) jl.push({ account: "2400", credit: creditBase, currency: cur, amountOrig: rest, fx, contactId: r.customer_id });
    if (fxDiff.gt(0)) jl.push({ account: "7100", credit: fxDiff, memo: "ربح فرق صرف محقق" });
    if (fxDiff.lt(0)) jl.push({ account: "7100", debit: fxDiff.abs(), memo: "خسارة فرق صرف محققة" });
    await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${who.companyId}, ${ca!.id}, ${r.amount}, ${cashBase.toString()}, 'customer_receipt', ${id})`;
  } else {
    if (arBase.gt(await customerCredit(tx, r.customer_id))) throw conflict("INSUFFICIENT_CREDIT", "الرصيد الدائن للعميل لا يكفي");
    jl.push({ account: "2400", debit: arBase, currency: cur, amountOrig: allocated, fx, contactId: r.customer_id }, { account: "1200", credit: arBase, currency: cur, amountOrig: allocated, fx, contactId: r.customer_id });
  }
  const je = await postJournal(tx, actor, { date, sourceDocType: "customer_receipt", sourceDocId: id, memo: r.kind === "CASH" ? `سند قبض ${docNo}` : `تسوية رصيد دائن ${docNo}`, lines: jl });
  const [h] = await tx`UPDATE customer_receipts SET status = 'POSTED', doc_no = ${docNo}, amount_base = ${cashBase.toString()}, fx_diff_base = ${fxDiff.toString()}, posted_by = ${who.userId}, posted_at = now(),
      journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, doc_no AS "docNo", status, fx_diff_base::text AS "fxDiffBase"`;
  await audit(tx, actor, { action: "receipt.post", entityType: "customer_receipt", entityId: id, after: { docNo, fxDiff: fxDiff.toString() } });
  return h!;
}

/** Internal: the receipt created by a CASH sale — one POSTED receipt fully allocated to its invoice. */
export async function createCashReceipt(tx: Tx, who: Principal, actor: Actor, o: { customerId: string; docDate: string; cashAccountId: string; currency: string; rate: string; amount: string; invoiceId: string; auto: boolean }) {
  const [r] = await tx`INSERT INTO customer_receipts(company_id, draft_ref, doc_date, kind, customer_id, cash_account_id, auto_for_invoice_id, currency, exchange_rate_snapshot, amount, notes, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${o.docDate}, 'CASH', ${o.customerId}, ${o.cashAccountId}, ${o.auto ? o.invoiceId : null}, ${o.currency}, ${o.rate}, ${o.amount}, 'قبض تلقائي لبيع نقدي', ${who.userId}) RETURNING id`;
  await tx`INSERT INTO receipt_allocations(company_id, receipt_id, invoice_id, amount) VALUES (${who.companyId}, ${r!.id}, ${o.invoiceId}, ${o.amount})`;
  return postReceipt(tx, who, actor, r!.id);
}

export async function reverseReceiptCore(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [r] = await tx`SELECT * FROM customer_receipts WHERE id = ${id} FOR UPDATE`;
  if (!r) throw notFound();
  if (r.status !== "POSTED") throw conflict("NOT_POSTED");
  await reverseEntry(tx, actor, r.journal_entry_id, new Date().toISOString().slice(0, 10), `عكس سند قبض ${r.doc_no}: ${reason}`);
  if (r.kind === "CASH") await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id)
    SELECT company_id, cash_account_id, -amount, -amount_base, 'customer_receipt', doc_id FROM cash_movements WHERE doc_type = 'customer_receipt' AND doc_id = ${id} AND amount > 0`;
  await tx`UPDATE customer_receipts SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "receipt.reverse", entityType: "customer_receipt", entityId: id, reason });
  return { id, status: "REVERSED" };
}
export async function reverseReceipt(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [r] = await tx`SELECT auto_for_invoice_id FROM customer_receipts WHERE id = ${id}`;
  if (r?.auto_for_invoice_id) throw conflict("AUTO_RECEIPT", "هذا القبض تلقائي لبيع نقدي؛ اعكس الفاتورة بدلاً منه");
  return reverseReceiptCore(tx, who, actor, id, reason);
}

// =========================== cash transfers (custody hand-over) ===========================
export const cashTransferSchema = z.object({ docDate: dateStr, fromAccountId: uuid, toAccountId: uuid, amount: moneyStr, notes: z.string().max(300).nullish() });

export async function createCashTransfer(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof cashTransferSchema>) {
  if (i.fromAccountId === i.toAccountId) throw badRequest("SAME_ACCOUNT");
  const accs = await tx`SELECT id, currency FROM cash_accounts WHERE id IN ${tx([i.fromAccountId, i.toAccountId])} AND is_active`;
  if (accs.length !== 2) throw badRequest("BAD_CASH_ACCOUNT");
  if (accs[0]!.currency !== accs[1]!.currency) throw badRequest("CURRENCY_MISMATCH", "التحويل بين صندوقين بعملتين مختلفتين غير مدعوم بعد");
  if (d(i.amount).lte(0)) throw badRequest("INVALID_AMOUNT");
  const cur = accs[0]!.currency as string, rate = await resolveRate(tx, cur, i.docDate);
  const [t] = await tx`INSERT INTO cash_transfers(company_id, draft_ref, doc_date, from_account_id, to_account_id, currency, exchange_rate_snapshot, amount, notes, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${i.docDate}, ${i.fromAccountId}, ${i.toAccountId}, ${cur}, ${rate}, ${i.amount}, ${i.notes ?? null}, ${who.userId}) RETURNING id, draft_ref AS "draftRef", version`;
  await audit(tx, actor, { action: "cash_transfer.create_draft", entityType: "cash_transfer", entityId: t!.id, after: i });
  return t!;
}
export async function deleteCashTransferDraft(tx: Tx, actor: Actor, id: string) {
  const [cur] = await tx`SELECT status FROM cash_transfers WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.status !== "DRAFT") throw conflict("NOT_DRAFT", "الحذف للمسودات فقط");
  await tx`DELETE FROM cash_transfers WHERE id = ${id}`;
  await audit(tx, actor, { action: "cash_transfer.delete_draft", entityType: "cash_transfer", entityId: id });
}
export async function listCashTransfers(tx: Tx) {
  return tx`SELECT t.id, t.draft_ref AS "draftRef", t.doc_no AS "docNo", t.doc_date::text AS "docDate", f.name AS "from", o.name AS "to", t.currency, t.amount::text AS amount, t.status
    FROM cash_transfers t JOIN cash_accounts f ON f.id = t.from_account_id JOIN cash_accounts o ON o.id = t.to_account_id ORDER BY t.doc_date DESC, t.created_at DESC LIMIT 200`;
}
export async function postCashTransfer(tx: Tx, who: Principal, actor: Actor, id: string) {
  const [t] = await tx`SELECT * FROM cash_transfers WHERE id = ${id} FOR UPDATE`;
  if (!t) throw notFound();
  if (t.status !== "DRAFT") throw conflict("NOT_DRAFT");
  const date = dateOf(t.doc_date), cur = t.currency as string, fx = t.exchange_rate_snapshot as string;
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'cash_transfer', ${yearOf(date)}) AS n`)[0]!.n as string;
  const base = toBase(t.amount, fx, cur);
  await assertCashAvailable(tx, t.from_account_id, t.amount);
  const [from] = await tx`SELECT ca.id, a.code FROM cash_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = ${t.from_account_id}`;
  const [to] = await tx`SELECT ca.id, a.code FROM cash_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = ${t.to_account_id}`;
  const je = await postJournal(tx, actor, { date, sourceDocType: "cash_transfer", sourceDocId: id, memo: `سند تحويل ${docNo}`,
    lines: [{ account: to!.code, debit: base, currency: cur, amountOrig: t.amount, fx }, { account: from!.code, credit: base, currency: cur, amountOrig: t.amount, fx }] });
  await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${who.companyId}, ${from!.id}, ${d(t.amount).neg().toString()}, ${base.neg().toString()}, 'cash_transfer', ${id}), (${who.companyId}, ${to!.id}, ${t.amount}, ${base.toString()}, 'cash_transfer', ${id})`;
  const [h] = await tx`UPDATE cash_transfers SET status = 'POSTED', doc_no = ${docNo}, posted_by = ${who.userId}, posted_at = now(), journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, doc_no AS "docNo", status`;
  await audit(tx, actor, { action: "cash_transfer.post", entityType: "cash_transfer", entityId: id, after: { docNo } });
  return h!;
}
export async function reverseCashTransfer(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [t] = await tx`SELECT * FROM cash_transfers WHERE id = ${id} FOR UPDATE`;
  if (!t) throw notFound();
  if (t.status !== "POSTED") throw conflict("NOT_POSTED");
  await reverseEntry(tx, actor, t.journal_entry_id, new Date().toISOString().slice(0, 10), `عكس سند تحويل ${t.doc_no}: ${reason}`);
  await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) SELECT company_id, cash_account_id, -amount, -amount_base, 'cash_transfer', doc_id FROM cash_movements WHERE doc_type = 'cash_transfer' AND doc_id = ${id}`;
  await tx`UPDATE cash_transfers SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "cash_transfer.reverse", entityType: "cash_transfer", entityId: id, reason });
  return { id, status: "REVERSED" };
}
void Decimal;

// ---- single-document readers (print / PDF) ----
export async function getReceipt(tx: Tx, id: string) {
  const [r] = await tx`SELECT r.id, r.doc_no AS "docNo", r.draft_ref AS "draftRef", r.doc_date::text AS "docDate", r.kind, c.name AS "customerName", ca.name AS "cashAccount", r.currency, r.exchange_rate_snapshot::text AS "exchangeRate",
      r.amount::text AS amount, r.notes, r.status FROM customer_receipts r JOIN contacts c ON c.id = r.customer_id LEFT JOIN cash_accounts ca ON ca.id = r.cash_account_id WHERE r.id = ${id}`;
  if (!r) throw notFound();
  const allocations = await tx`SELECT si.doc_no AS "invoiceNo", a.amount::text AS amount FROM receipt_allocations a JOIN sales_invoices si ON si.id = a.invoice_id WHERE a.receipt_id = ${id}`;
  return { ...r, allocations };
}
export async function getCashTransfer(tx: Tx, id: string) {
  const [t] = await tx`SELECT t.id, t.doc_no AS "docNo", t.draft_ref AS "draftRef", t.doc_date::text AS "docDate", f.name AS "from", o.name AS "to", t.currency, t.amount::text AS amount, t.notes, t.status
    FROM cash_transfers t JOIN cash_accounts f ON f.id = t.from_account_id JOIN cash_accounts o ON o.id = t.to_account_id WHERE t.id = ${id}`;
  if (!t) throw notFound();
  return t;
}
