import { z } from "zod";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { d, toBase } from "../money";
import { postJournal, reverseEntry } from "../ledger";
import { requireStepUp } from "../stepup";
import { assertCashAvailable } from "./cash";
import { currencyCode, dateStr, draftRef, moneyStr, rateStr, resolveRate, uuid, yearOf } from "./common";

const dateOf = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const cashRow = async (tx: Tx, id: string) => (await tx`SELECT ca.id, ca.currency, a.code FROM cash_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = ${id} AND ca.is_active`)[0];
const partnerOf = async (tx: Tx, kind: "OWNER" | "PARTNER") => (await tx`SELECT id FROM partners WHERE kind = ${kind}`)[0]!.id as string;

// =========================== capital ===========================
export const capitalSchema = z.object({ kind: z.enum(["INJECTION", "WITHDRAWAL"]), docDate: dateStr, cashAccountId: uuid, currency: currencyCode, exchangeRate: rateStr.nullish(), amount: moneyStr, reason: z.string().min(3).max(500) });

/** Anyone with the right can REQUEST; only the owner can approve (server + database enforce it). The owner alone funds capital. */
export async function requestCapital(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof capitalSchema>) {
  if (d(i.amount).lte(0)) throw badRequest("INVALID_AMOUNT");
  const c = await cashRow(tx, i.cashAccountId);
  if (!c || c.currency !== i.currency) throw badRequest("CASH_CURRENCY_MISMATCH", "عملة الصندوق يجب أن تطابق العملة");
  const rate = await resolveRate(tx, i.currency, i.docDate, i.exchangeRate ?? undefined);
  const owner = await partnerOf(tx, "OWNER");
  const [r] = await tx`INSERT INTO capital_transactions(company_id, draft_ref, doc_date, kind, partner_id, cash_account_id, currency, exchange_rate_snapshot, amount, reason, requested_by, status)
    VALUES (${who.companyId}, ${draftRef()}, ${i.docDate}, ${i.kind}, ${owner}, ${i.cashAccountId}, ${i.currency}, ${rate}, ${i.amount}, ${i.reason}, ${who.userId}, 'REQUESTED') RETURNING id, draft_ref AS "draftRef", status, version`;
  await audit(tx, actor, { action: `capital.request_${i.kind.toLowerCase()}`, entityType: "capital_transaction", entityId: r!.id, after: i, reason: i.reason });
  return r!;
}

export async function listCapital(tx: Tx) {
  return tx`SELECT t.id, t.draft_ref AS "draftRef", t.doc_no AS "docNo", t.doc_date::text AS "docDate", t.kind, t.currency, t.amount::text AS amount, t.reason, t.status, t.rejected_reason AS "rejectedReason",
      ru.display_name AS "requestedBy", au.display_name AS "approvedBy"
    FROM capital_transactions t JOIN users ru ON ru.id = t.requested_by LEFT JOIN users au ON au.id = t.approved_by ORDER BY t.doc_date DESC, t.created_at DESC LIMIT 200`;
}
export async function capitalBalance(tx: Tx) {
  const [r] = await tx`SELECT COALESCE(sum(jl.credit_base - jl.debit_base), 0)::text AS cap FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '3100'`;
  return d(r!.cap);
}

export async function approveCapital(tx: Tx, who: Principal, actor: Actor, id: string, totp?: string | null) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  await requireStepUp(tx, who, totp);
  const [t] = await tx`SELECT * FROM capital_transactions WHERE id = ${id} FOR UPDATE`;
  if (!t) throw notFound();
  if (t.status !== "REQUESTED") throw conflict("NOT_REQUESTED", "الطلب ليس بانتظار الاعتماد");
  const date = dateOf(t.doc_date), fx = t.exchange_rate_snapshot as string, cur = t.currency as string, base = toBase(t.amount, fx, cur);
  const c = (await cashRow(tx, t.cash_account_id))!;
  if (t.kind === "WITHDRAWAL") {
    await assertCashAvailable(tx, t.cash_account_id, t.amount);
    const cap = await capitalBalance(tx);
    if (base.gt(cap)) throw conflict("EXCEEDS_CAPITAL", `السحب (${base}) يتجاوز رأس المال القائم (${cap})؛ الأرباح تُسحب عبر تسوية الأرباح`);
  }
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'capital', ${yearOf(date)}) AS n`)[0]!.n as string;
  const inj = t.kind === "INJECTION";
  const je = await postJournal(tx, actor, { date, sourceDocType: "capital", sourceDocId: id, memo: `${inj ? "إيداع" : "سحب"} رأس مال ${docNo}: ${t.reason}`,
    lines: [inj ? { account: c.code, debit: base, currency: cur, amountOrig: t.amount, fx } : { account: "3100", debit: base, partnerId: t.partner_id },
            inj ? { account: "3100", credit: base, partnerId: t.partner_id } : { account: c.code, credit: base, currency: cur, amountOrig: t.amount, fx }] });
  await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${who.companyId}, ${c.id}, ${inj ? t.amount : d(t.amount).neg().toString()}, ${inj ? base.toString() : base.neg().toString()}, 'capital', ${id})`;
  const [h] = await tx`UPDATE capital_transactions SET status = 'POSTED', doc_no = ${docNo}, amount_base = ${base.toString()}, approved_by = ${who.userId}, posted_at = now(), journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, doc_no AS "docNo", status`;
  await audit(tx, actor, { action: `capital.approve_${t.kind.toLowerCase()}`, entityType: "capital_transaction", entityId: id, after: { docNo, base: base.toString() }, reason: t.reason });
  return h!;
}

export async function rejectCapital(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [t] = await tx`SELECT * FROM capital_transactions WHERE id = ${id} FOR UPDATE`;
  if (!t) throw notFound();
  if (t.status !== "REQUESTED") throw conflict("NOT_REQUESTED");
  if (!who.isOwner && t.requested_by !== who.userId) throw forbidden("OWNER_ONLY");        // requesters may withdraw their own request; only the owner rejects others'
  await tx`UPDATE capital_transactions SET status = 'REJECTED', rejected_reason = ${reason}, version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "capital.reject", entityType: "capital_transaction", entityId: id, reason });
  return { id, status: "REJECTED" };
}

export async function reverseCapital(tx: Tx, who: Principal, actor: Actor, id: string, reason: string, totp?: string | null) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  await requireStepUp(tx, who, totp);
  const [t] = await tx`SELECT * FROM capital_transactions WHERE id = ${id} FOR UPDATE`;
  if (!t) throw notFound();
  if (t.status !== "POSTED") throw conflict("NOT_POSTED");
  if (t.kind === "INJECTION") await assertCashAvailable(tx, t.cash_account_id, t.amount);
  await reverseEntry(tx, actor, t.journal_entry_id, new Date().toISOString().slice(0, 10), `عكس رأس مال ${t.doc_no}: ${reason}`);
  await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) SELECT company_id, cash_account_id, -amount, -amount_base, 'capital', doc_id FROM cash_movements WHERE doc_type = 'capital' AND doc_id = ${id}`;
  await tx`UPDATE capital_transactions SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "capital.reverse", entityType: "capital_transaction", entityId: id, reason });
  return { id, status: "REVERSED" };
}

// =========================== personal draws (never an operating expense) ===========================
export const advanceSchema = z.object({ partnerKind: z.enum(["OWNER", "PARTNER"]), kind: z.enum(["DRAW", "REPAYMENT"]), docDate: dateStr, cashAccountId: uuid, currency: currencyCode, exchangeRate: rateStr.nullish(), amount: moneyStr, note: z.string().max(300).nullish() });

export async function createAdvance(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof advanceSchema>) {
  const c = await cashRow(tx, i.cashAccountId);
  if (!c || c.currency !== i.currency) throw badRequest("CASH_CURRENCY_MISMATCH");
  const rate = await resolveRate(tx, i.currency, i.docDate, i.exchangeRate ?? undefined), partner = await partnerOf(tx, i.partnerKind);
  const [a] = await tx`INSERT INTO personal_advances(company_id, draft_ref, doc_date, partner_id, kind, cash_account_id, currency, exchange_rate_snapshot, amount, note, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${i.docDate}, ${partner}, ${i.kind}, ${i.cashAccountId}, ${i.currency}, ${rate}, ${i.amount}, ${i.note ?? null}, ${who.userId}) RETURNING id, draft_ref AS "draftRef", version`;
  await audit(tx, actor, { action: "personal_advance.create_draft", entityType: "personal_advance", entityId: a!.id, after: i });
  return a!;
}
export async function deleteAdvanceDraft(tx: Tx, actor: Actor, id: string) {
  const [a] = await tx`SELECT status FROM personal_advances WHERE id = ${id} FOR UPDATE`;
  if (!a) throw notFound();
  if (a.status !== "DRAFT") throw conflict("NOT_DRAFT", "الحذف للمسودات فقط");
  await tx`DELETE FROM personal_advances WHERE id = ${id}`;
  await audit(tx, actor, { action: "personal_advance.delete_draft", entityType: "personal_advance", entityId: id });
}
export async function listAdvances(tx: Tx) {
  return tx`SELECT a.id, a.draft_ref AS "draftRef", a.doc_no AS "docNo", a.doc_date::text AS "docDate", p.kind AS "partnerKind", p.name AS "partnerName", a.kind, a.currency, a.amount::text AS amount, a.note, a.status
    FROM personal_advances a JOIN partners p ON p.id = a.partner_id ORDER BY a.doc_date DESC, a.created_at DESC LIMIT 200`;
}
/** Owner draw -> equity (3200). Partner draw -> advance (1250), settled against his profit payouts. Repayment reverses it. */
export async function postAdvance(tx: Tx, who: Principal, actor: Actor, id: string) {
  const [a] = await tx`SELECT a.*, p.kind AS pkind FROM personal_advances a JOIN partners p ON p.id = a.partner_id WHERE a.id = ${id} FOR UPDATE OF a`;
  if (!a) throw notFound();
  if (a.status !== "DRAFT") throw conflict("NOT_DRAFT");
  const date = dateOf(a.doc_date), fx = a.exchange_rate_snapshot as string, cur = a.currency as string, base = toBase(a.amount, fx, cur);
  const c = (await cashRow(tx, a.cash_account_id))!, acct = a.pkind === "OWNER" ? "3200" : "1250";
  const draw = a.kind === "DRAW";
  if (draw) await assertCashAvailable(tx, a.cash_account_id, a.amount);
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'personal_advance', ${yearOf(date)}) AS n`)[0]!.n as string;
  const je = await postJournal(tx, actor, { date, sourceDocType: "personal_advance", sourceDocId: id, memo: `${draw ? "سحب شخصي" : "سداد سلفة"} ${docNo}`,
    lines: [draw ? { account: acct, debit: base, partnerId: a.partner_id } : { account: c.code, debit: base, currency: cur, amountOrig: a.amount, fx },
            draw ? { account: c.code, credit: base, currency: cur, amountOrig: a.amount, fx } : { account: acct, credit: base, partnerId: a.partner_id }] });
  await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${who.companyId}, ${c.id}, ${draw ? d(a.amount).neg().toString() : a.amount}, ${draw ? base.neg().toString() : base.toString()}, 'personal_advance', ${id})`;
  await tx`UPDATE personal_advances SET status = 'POSTED', doc_no = ${docNo}, amount_base = ${base.toString()}, posted_by = ${who.userId}, posted_at = now(), journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "personal_advance.post", entityType: "personal_advance", entityId: id, after: { docNo, base: base.toString(), kind: a.kind } });
  return { id, docNo, status: "POSTED" };
}
export async function reverseAdvance(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [a] = await tx`SELECT * FROM personal_advances WHERE id = ${id} FOR UPDATE`;
  if (!a) throw notFound();
  if (a.status !== "POSTED") throw conflict("NOT_POSTED");
  if (a.kind === "REPAYMENT") await assertCashAvailable(tx, a.cash_account_id, a.amount);
  await reverseEntry(tx, actor, a.journal_entry_id, new Date().toISOString().slice(0, 10), `عكس ${a.doc_no}: ${reason}`);
  await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) SELECT company_id, cash_account_id, -amount, -amount_base, 'personal_advance', doc_id FROM cash_movements WHERE doc_type = 'personal_advance' AND doc_id = ${id}`;
  await tx`UPDATE personal_advances SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "personal_advance.reverse", entityType: "personal_advance", entityId: id, reason });
  return { id, status: "REVERSED" };
}

// =========================== person-to-person debts: record only, outside the business books ===========================
export const debtSchema = z.object({ person: z.string().min(2).max(120), direction: z.enum(["THEY_OWE_ME", "I_OWE_THEM"]), currency: currencyCode, amount: moneyStr, note: z.string().max(300).nullish() });
export const listDebts = (tx: Tx) => tx`SELECT id, person, direction, currency, amount::text AS amount, paid::text AS paid, (amount - paid)::text AS remaining, note, created_at AS "createdAt" FROM personal_debts ORDER BY created_at DESC LIMIT 200`;
export async function createDebt(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof debtSchema>) {
  const [r] = await tx`INSERT INTO personal_debts(company_id, person, direction, currency, amount, note, created_by) VALUES (${who.companyId}, ${i.person}, ${i.direction}, ${i.currency}, ${i.amount}, ${i.note ?? null}, ${who.userId}) RETURNING id`;
  await audit(tx, actor, { action: "personal_debt.create", entityType: "personal_debt", entityId: r!.id, after: i });
  return r!;
}
export async function payDebt(tx: Tx, actor: Actor, id: string, amount: string) {
  const [r] = await tx`UPDATE personal_debts SET paid = paid + ${amount} WHERE id = ${id} AND paid + ${amount} <= amount RETURNING id, paid::text AS paid`;
  if (!r) throw conflict("OVER_PAYMENT", "المبلغ يتجاوز المتبقي أو السجل غير موجود");
  await audit(tx, actor, { action: "personal_debt.pay", entityType: "personal_debt", entityId: id, after: { amount } });
  return r;
}
