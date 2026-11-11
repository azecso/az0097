import { z } from "zod";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, conflict, notFound } from "../errors";
import { d, toBase } from "../money";
import { postJournal, reverseEntry, type JLine } from "../ledger";
import { assertCashAvailable, reverseCashMovements } from "./cash";
import { customerCreditIn } from "./receipts";
import { dateStr, moneyStr, rateStr, resolveRate, uuid, yearOf } from "./common";

export const refundSchema = z.object({ requestId: z.string().min(8).max(120), customerId: uuid, docDate: dateStr, cashAccountId: uuid, amount: moneyStr, exchangeRate: rateStr.nullish(), reason: z.string().trim().min(3).max(300) });

/**
 * Hand real cash back to a customer who holds credit. Bounded by the credit the customer actually has IN THAT CURRENCY (credit never crosses currencies). Dr 2400 at the dinar value the credit
 * is carried at (pro rata), Cr cash at the day's rate, the difference is a realised FX result — counted once. Atomic and idempotent by requestId.
 */
export async function refundCredit(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof refundSchema>) {
  const { once } = await import("../idempotency");
  return once(tx, who, i.requestId, `refund:${i.customerId}`, async () => {
    const amount = d(i.amount); if (amount.lte(0)) throw badRequest("INVALID_AMOUNT");
    const [c] = await tx`SELECT kind FROM contacts WHERE id = ${i.customerId}`; if (!c || c.kind === "SUPPLIER") throw badRequest("NOT_A_CUSTOMER");
    const [ca] = await tx`SELECT ca.id, ca.currency, a.code FROM cash_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = ${i.cashAccountId} AND ca.is_active`;
    if (!ca) throw badRequest("CASH_ACCOUNT_REQUIRED"); const cur = ca.currency as string;
    const avail = await customerCreditIn(tx, i.customerId, cur);
    if (amount.gt(avail.orig)) throw conflict("INSUFFICIENT_CREDIT", `رصيد العميل الدائن بعملة ${cur} هو ${avail.orig} فقط؛ لا يُرَدّ أكثر منه`);
    const fx = await resolveRate(tx, cur, i.docDate, i.exchangeRate ?? undefined);
    const carried = amount.eq(avail.orig) ? avail.base : toBase(avail.base.mul(amount).div(avail.orig), 1, "IQD");
    const cashBase = toBase(amount, fx, cur), diff = cashBase.minus(carried);                       // + = paid out more dinars than the credit was carried at (loss)
    await assertCashAvailable(tx, ca.id as string, amount);
    const jl: JLine[] = [{ account: "2400", debit: carried, currency: cur, amountOrig: amount, fx, contactId: i.customerId }, { account: ca.code as string, credit: cashBase, currency: cur, amountOrig: amount, fx }];
    if (diff.gt(0)) jl.push({ account: "7100", debit: diff, memo: "خسارة فرق صرف محققة" }); if (diff.lt(0)) jl.push({ account: "7100", credit: diff.abs(), memo: "ربح فرق صرف محقق" });
    await tx`INSERT INTO document_sequences(company_id, doc_type, fiscal_year, prefix) VALUES (${who.companyId}, 'customer_refund', ${yearOf(i.docDate)}, 'CF') ON CONFLICT DO NOTHING`;
    const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'customer_refund', ${yearOf(i.docDate)}) AS n`)[0]!.n as string;
    const rid = crypto.randomUUID();
    const je = await postJournal(tx, actor, { date: i.docDate, sourceDocType: "customer_refund", sourceDocId: rid, memo: `ردّ نقد لرصيد دائن ${docNo}`, lines: jl });
    const [r] = await tx`INSERT INTO customer_refunds(id, company_id, doc_no, doc_date, customer_id, cash_account_id, currency, exchange_rate_snapshot, amount, amount_base, fx_diff_base, reason, journal_entry_id, created_by)
      VALUES (${rid}, ${who.companyId}, ${docNo}, ${i.docDate}, ${i.customerId}, ${i.cashAccountId}, ${cur}, ${fx}, ${i.amount}, ${cashBase.toString()}, ${diff.toString()}, ${i.reason}, ${je}, ${who.userId}) RETURNING id`;
    await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${who.companyId}, ${ca.id}, ${amount.neg().toString()}, ${cashBase.neg().toString()}, 'customer_refund', ${rid})`;
    await audit(tx, actor, { action: "customer_refund.create", entityType: "customer_refund", entityId: r!.id as string, after: { docNo, amount: i.amount, currency: cur, reason: i.reason } });
    return { id: r!.id as string, docNo, currency: cur, amount: i.amount };
  });
}
export const listRefunds = (tx: Tx) => tx`SELECT r.id, r.doc_no AS "docNo", r.doc_date::text AS "docDate", c.name AS "customerName", ca.name AS "cashAccount", r.currency, r.amount::text AS amount, r.reason, r.status
  FROM customer_refunds r JOIN contacts c ON c.id = r.customer_id JOIN cash_accounts ca ON ca.id = r.cash_account_id ORDER BY r.doc_date DESC, r.created_at DESC LIMIT 300`;
export async function reverseRefund(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [r] = await tx`SELECT * FROM customer_refunds WHERE id = ${id} FOR UPDATE`; if (!r) throw notFound();
  if (r.status !== "POSTED") throw conflict("NOT_POSTED");
  await reverseEntry(tx, actor, r.journal_entry_id, new Date().toISOString().slice(0, 10), `عكس ردّ نقد ${r.doc_no}: ${reason}`);
  await reverseCashMovements(tx, "customer_refund", id);
  await tx`UPDATE customer_refunds SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "customer_refund.reverse", entityType: "customer_refund", entityId: id, reason });
  return { id, status: "REVERSED" };
}
void d;
