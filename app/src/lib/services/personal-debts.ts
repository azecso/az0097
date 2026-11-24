import { z } from "zod";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, conflict, notFound } from "../errors";
import { d } from "../money";
import { currencyCode, dateStr, moneyStr, uuid, yearOf } from "./common";

/**
 * Personal debt (دين شخصي): a person — the owner, the partner, or anyone named — took money on credit. DOCUMENTATION ONLY: no cash movement, no journal entry, no effect on the
 * cash box, equity, partner advances or profit. Repayment is documentation too (settled outside the box). Cancelling keeps the record with its reason.
 */
export const debtSchema = z.object({
  requestId: z.string().min(8).max(120), partnerKind: z.enum(["OWNER", "PARTNER"]).nullish(), person: z.string().trim().max(120).nullish(), docDate: dateStr, currency: currencyCode, amount: moneyStr, note: z.string().max(300).nullish(),
}).refine((v) => !!v.partnerKind || (v.person ?? "").length >= 2, { message: "اختر المالك أو الشريك، أو اكتب اسم الشخص" });
export const debtPaymentSchema = z.object({ requestId: z.string().min(8).max(120), payDate: dateStr, amount: moneyStr, note: z.string().max(300).nullish() });

export async function createDebt(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof debtSchema>) {
  const { once } = await import("../idempotency");
  return once(tx, who, i.requestId, "personal_debt:create", async () => {
    if (d(i.amount).lte(0)) throw badRequest("INVALID_AMOUNT", "المبلغ يجب أن يكون موجباً");
    let name = (i.person ?? "").trim();
    let partnerId: string | null = null;
    if (i.partnerKind) { const [p] = await tx`SELECT id, name FROM partners WHERE kind = ${i.partnerKind}`; if (!p) throw badRequest("BAD_PARTNER"); name = p.name as string; partnerId = p.id as string; }
    await tx`INSERT INTO document_sequences(company_id, doc_type, fiscal_year, prefix) VALUES (${who.companyId}, 'personal_debt', ${yearOf(i.docDate)}, 'PD') ON CONFLICT DO NOTHING`;
    const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'personal_debt', ${yearOf(i.docDate)}) AS n`)[0]!.n as string;
    const [r] = await tx`INSERT INTO personal_debts(company_id, doc_no, doc_date, partner_id, person, direction, currency, amount, note, created_by)
      VALUES (${who.companyId}, ${docNo}, ${i.docDate}, ${partnerId}, ${name}, 'THEY_OWE_ME', ${i.currency}, ${i.amount}, ${i.note ?? null}, ${who.userId}) RETURNING id`;
    await audit(tx, actor, { action: "personal_debt.create", entityType: "personal_debt", entityId: r!.id as string, after: { docNo, person: name, amount: i.amount, currency: i.currency } });
    return { id: r!.id as string, docNo, person: name };
  });
}

export async function listDebts(tx: Tx) {
  const debts = await tx`SELECT g.id, g.doc_no AS "docNo", g.doc_date::text AS "docDate", g.person, g.partner_id AS "partnerId", g.currency, g.amount::text AS amount, g.note, g.status, g.reverse_reason AS "reverseReason",
      COALESCE((SELECT sum(p.amount) FROM personal_debt_payments p WHERE p.debt_id = g.id AND p.status = 'ACTIVE'), 0)::text AS paid
    FROM personal_debts g WHERE g.direction = 'THEY_OWE_ME' ORDER BY g.doc_date DESC, g.created_at DESC LIMIT 500`;
  const pays = await tx`SELECT p.id, p.debt_id AS "debtId", p.pay_date::text AS "payDate", p.amount::text AS amount, p.note, p.status FROM personal_debt_payments p ORDER BY p.pay_date, p.created_at`;
  return debts.map((g) => {
    const paid = d(g.paid as string), remaining = g.status === "ACTIVE" ? d(g.amount as string).minus(paid) : d(0);
    return { ...g, remaining: remaining.toString(), state: g.status === "REVERSED" ? "REVERSED" : remaining.isZero() ? "PAID" : paid.gt(0) ? "PARTIAL" : "OPEN", payments: pays.filter((p) => p.debtId === g.id) };
  });
}
/** What each person still owes, per currency (active debts only). */
export async function debtTotals(tx: Tx) {
  return tx`SELECT g.person, g.currency, sum(g.amount)::text AS debts,
      COALESCE(sum((SELECT sum(p.amount) FROM personal_debt_payments p WHERE p.debt_id = g.id AND p.status = 'ACTIVE')), 0)::text AS paid,
      (sum(g.amount) - COALESCE(sum((SELECT sum(p.amount) FROM personal_debt_payments p WHERE p.debt_id = g.id AND p.status = 'ACTIVE')), 0))::text AS remaining
    FROM personal_debts g WHERE g.direction = 'THEY_OWE_ME' AND g.status = 'ACTIVE' GROUP BY g.person, g.currency ORDER BY g.person, g.currency`;
}

export async function payDebt(tx: Tx, who: Principal, actor: Actor, id: string, i: z.infer<typeof debtPaymentSchema>) {
  const { once } = await import("../idempotency");
  return once(tx, who, i.requestId, `personal_debt:pay:${id}`, async () => {
    const [g] = await tx`SELECT id, status, amount::text AS amount, doc_no FROM personal_debts WHERE id = ${id} FOR UPDATE`; if (!g) throw notFound();
    if (g.status !== "ACTIVE") throw conflict("DEBT_CANCELLED", "الدين ملغى");
    const amount = d(i.amount); if (amount.lte(0)) throw badRequest("INVALID_AMOUNT", "المبلغ يجب أن يكون موجباً");
    const paid = d((await tx`SELECT COALESCE(sum(amount), 0)::text AS s FROM personal_debt_payments WHERE debt_id = ${id} AND status = 'ACTIVE'`)[0]!.s as string);
    if (paid.plus(amount).gt(g.amount as string)) throw conflict("OVER_PAYMENT", `المبلغ يتجاوز المتبقي (${d(g.amount as string).minus(paid)})`);
    const [r] = await tx`INSERT INTO personal_debt_payments(company_id, debt_id, pay_date, amount, note, created_by) VALUES (${who.companyId}, ${id}, ${i.payDate}, ${i.amount}, ${i.note ?? null}, ${who.userId}) RETURNING id`;
    await tx`UPDATE personal_debts SET paid = ${paid.plus(amount).toString()} WHERE id = ${id}`;
    await audit(tx, actor, { action: "personal_debt.pay", entityType: "personal_debt", entityId: id, after: { amount: i.amount, payDate: i.payDate, note: i.note ?? null } });
    return { id: r!.id as string, remaining: d(g.amount as string).minus(paid).minus(amount).toString() };
  });
}

export const reverseDebtSchema = z.object({ reason: z.string().trim().min(3).max(300) });
export async function reverseDebt(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [g] = await tx`SELECT status FROM personal_debts WHERE id = ${id} FOR UPDATE`; if (!g) throw notFound();
  if (g.status !== "ACTIVE") throw conflict("DEBT_CANCELLED");
  if ((await tx`SELECT 1 FROM personal_debt_payments WHERE debt_id = ${id} AND status = 'ACTIVE'`).length) throw conflict("HAS_PAYMENTS", "توجد تسديدات على هذا الدين؛ أَلغِها أولاً");
  await tx`UPDATE personal_debts SET status = 'REVERSED', reverse_reason = ${reason} WHERE id = ${id}`;
  await audit(tx, actor, { action: "personal_debt.reverse", entityType: "personal_debt", entityId: id, reason });
  return { id, status: "REVERSED" };
}
export async function reverseDebtPayment(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [p] = await tx`SELECT p.id, p.status, p.debt_id, p.amount FROM personal_debt_payments p WHERE p.id = ${id} FOR UPDATE`; if (!p) throw notFound();
  if (p.status !== "ACTIVE") throw conflict("PAYMENT_CANCELLED");
  await tx`UPDATE personal_debt_payments SET status = 'REVERSED', reverse_reason = ${reason} WHERE id = ${id}`;
  await tx`UPDATE personal_debts SET paid = COALESCE((SELECT sum(amount) FROM personal_debt_payments WHERE debt_id = ${p.debt_id} AND status = 'ACTIVE'), 0) WHERE id = ${p.debt_id}`;
  await audit(tx, actor, { action: "personal_debt.pay_reverse", entityType: "personal_debt", entityId: p.debt_id as string, reason, after: { paymentId: id, amount: p.amount } });
  return { id, status: "REVERSED" };
}
