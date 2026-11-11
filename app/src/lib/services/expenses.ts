import { z } from "zod";
import Decimal from "decimal.js";
import type { Tx } from "../db";
import { reverseCashMovements } from "./cash";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, conflict, notFound } from "../errors";
import { d, toBase } from "../money";
import { settleLiability } from "../fx-settlement";
import { postJournal, reverseEntry, type JLine } from "../ledger";
import { assertCashAvailable } from "./cash";
import { currencyCode, dateStr, draftRef, moneyStr, rateStr, resolveRate, uuid, yearOf } from "./common";

const dateOf = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const partnerOf = async (tx: Tx, kind: "OWNER" | "PARTNER") => (await tx`SELECT id FROM partners WHERE kind = ${kind}`)[0]!.id as string;
const cashRow = async (tx: Tx, id: string) => (await tx`SELECT ca.id, ca.currency, a.code FROM cash_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = ${id} AND ca.is_active`)[0];

// =========================== categories ===========================
export const categorySchema = z.object({ name: z.string().min(2).max(80), nature: z.enum(["FIXED", "VARIABLE"]), scope: z.enum(["DIRECT", "GENERAL"]), accountCode: z.string().regex(/^6\d{3}$/) });
export const listCategories = (tx: Tx) => tx`SELECT c.id, c.name, c.nature, c.scope, a.code AS "accountCode", c.is_active AS "isActive" FROM expense_categories c JOIN accounts a ON a.id = c.account_id ORDER BY c.name`;
export async function createCategory(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof categorySchema>) {
  const [a] = await tx`SELECT id FROM accounts WHERE code = ${i.accountCode} AND type = 'EXPENSE'`;
  if (!a) throw badRequest("ACCOUNT_NOT_FOUND", "حساب المصروف غير موجود (يجب أن يبدأ بـ 6)");
  const [c] = await tx`INSERT INTO expense_categories(company_id, name, nature, scope, account_id) VALUES (${who.companyId}, ${i.name}, ${i.nature}, ${i.scope}, ${a.id}) RETURNING id, name`;
  await audit(tx, actor, { action: "expense_category.create", entityType: "expense_category", entityId: c!.id, after: i });
  return c!;
}

// =========================== expenses ===========================
export const expenseSchema = z.object({
  docDate: dateStr, categoryId: uuid, description: z.string().min(2).max(300), currency: currencyCode, exchangeRate: rateStr.nullish(), amount: moneyStr,
  paymentMode: z.enum(["PAID_CASH", "ACCRUED", "PAID_BY_PARTNER"]), cashAccountId: uuid.nullish(),
  partnerTreatment: z.enum(["PAYABLE_TO_PARTNER", "OFFSET_AGAINST_ADVANCES"]).nullish(), settlementNote: z.string().max(500).nullish(),
});

export async function createExpense(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof expenseSchema>) {
  if (d(i.amount).lte(0)) throw badRequest("INVALID_AMOUNT");
  if ((i.paymentMode === "PAID_BY_PARTNER") !== !!i.partnerTreatment) throw badRequest("PARTNER_TREATMENT", "مصروف الشريك يتطلب اختيار معالجة واحدة (ذمة له أو تسوية موثقة) — ولا تُسجَّل مرتين");
  if (i.partnerTreatment === "OFFSET_AGAINST_ADVANCES" && (i.settlementNote ?? "").length < 5) throw badRequest("SETTLEMENT_NOTE_REQUIRED", "التسوية الأخرى تتطلب توثيقاً مكتوباً");
  if (i.paymentMode === "PAID_CASH") {
    const c = await cashRow(tx, i.cashAccountId ?? "");
    if (!c) throw badRequest("CASH_ACCOUNT_REQUIRED", "اختر الصندوق");
    if (c.currency !== i.currency) throw badRequest("CASH_CURRENCY_MISMATCH", "عملة الصندوق يجب أن تطابق عملة المصروف");
  }
  const [cat] = await tx`SELECT id FROM expense_categories WHERE id = ${i.categoryId} AND is_active`;
  if (!cat) throw badRequest("CATEGORY_NOT_FOUND");
  const rate = await resolveRate(tx, i.currency, i.docDate, i.exchangeRate ?? undefined);
  const [e] = await tx`INSERT INTO expenses(company_id, draft_ref, doc_date, category_id, description, currency, exchange_rate_snapshot, amount, payment_mode, cash_account_id, partner_treatment, settlement_note, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${i.docDate}, ${i.categoryId}, ${i.description}, ${i.currency}, ${rate}, ${i.amount}, ${i.paymentMode}, ${i.paymentMode === "PAID_CASH" ? i.cashAccountId! : null},
            ${i.partnerTreatment ?? null}, ${i.settlementNote ?? null}, ${who.userId}) RETURNING id, draft_ref AS "draftRef", version`;
  await audit(tx, actor, { action: "expense.create_draft", entityType: "expense", entityId: e!.id, after: i });
  return e!;
}
export async function deleteExpenseDraft(tx: Tx, actor: Actor, id: string) {
  const [cur] = await tx`SELECT status FROM expenses WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.status !== "DRAFT") throw conflict("NOT_DRAFT", "الحذف للمسودات فقط");
  await tx`DELETE FROM expenses WHERE id = ${id}`;
  await audit(tx, actor, { action: "expense.delete_draft", entityType: "expense", entityId: id });
}

export async function expenseOutstanding(tx: Tx, id: string) {
  const [r] = await tx`SELECT e.amount::text AS amount, e.payment_mode, e.partner_treatment, COALESCE((SELECT sum(p.amount) FROM expense_payments p WHERE p.expense_id = e.id AND p.status = 'POSTED'), 0)::text AS paid FROM expenses e WHERE e.id = ${id}`;
  if (!r) throw notFound();
  const owes = r.payment_mode === "ACCRUED" || r.partner_treatment === "PAYABLE_TO_PARTNER";
  return { paid: r.paid as string, outstanding: owes ? d(r.amount).minus(r.paid).toString() : "0" };
}

export async function listExpenses(tx: Tx, status?: string) {
  return tx`SELECT e.id, e.draft_ref AS "draftRef", e.doc_no AS "docNo", e.doc_date::text AS "docDate", c.name AS category, e.description, e.currency, e.amount::text AS amount, e.payment_mode AS "paymentMode",
      e.partner_treatment AS "partnerTreatment", e.status,
      CASE WHEN e.status = 'POSTED' AND (e.payment_mode = 'ACCRUED' OR e.partner_treatment = 'PAYABLE_TO_PARTNER') THEN (e.amount - COALESCE((SELECT sum(p.amount) FROM expense_payments p WHERE p.expense_id = e.id AND p.status = 'POSTED'), 0))::text ELSE '0' END AS outstanding
    FROM expenses e JOIN expense_categories c ON c.id = e.category_id WHERE (${status ?? null}::text IS NULL OR e.status = ${status ?? null}) ORDER BY e.doc_date DESC, e.created_at DESC LIMIT 300`;
}

/** The expense is recognised HERE, once (accrual). Later payments only reduce the liability. */
export async function postExpense(tx: Tx, who: Principal, actor: Actor, id: string) {
  const [e] = await tx`SELECT e.*, a.code AS acct FROM expenses e JOIN expense_categories c ON c.id = e.category_id JOIN accounts a ON a.id = c.account_id WHERE e.id = ${id} FOR UPDATE OF e`;
  if (!e) throw notFound();
  if (e.status !== "DRAFT") throw conflict("NOT_DRAFT");
  const date = dateOf(e.doc_date), fx = e.exchange_rate_snapshot as string, cur = e.currency as string, base = toBase(e.amount, fx, cur);
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'expense', ${yearOf(date)}) AS n`)[0]!.n as string;
  const jl: JLine[] = [{ account: e.acct, debit: base, currency: cur, amountOrig: e.amount, fx, memo: e.description }];
  if (e.payment_mode === "PAID_CASH") {
    await assertCashAvailable(tx, e.cash_account_id, e.amount);
    const c = (await cashRow(tx, e.cash_account_id))!;
    jl.push({ account: c.code, credit: base, currency: cur, amountOrig: e.amount, fx });
    await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${who.companyId}, ${c.id}, ${d(e.amount).neg().toString()}, ${base.neg().toString()}, 'expense', ${id})`;
  } else if (e.payment_mode === "ACCRUED") jl.push({ account: "2210", credit: base, currency: cur, amountOrig: e.amount, fx });
  else {
    const partner = await partnerOf(tx, "PARTNER");
    jl.push({ account: "2300", credit: base, currency: cur, amountOrig: e.amount, fx, partnerId: partner, memo: "مصروف دفعه الشريك من ماله" });
    if (e.partner_treatment === "OFFSET_AGAINST_ADVANCES") {          // documented settlement: nets against what the partner already drew
      const adv = d((await tx`SELECT COALESCE(sum(jl.debit_base - jl.credit_base), 0)::text AS b FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '1250' AND jl.partner_id = ${partner}`)[0]!.b);
      if (adv.lt(base)) throw conflict("INSUFFICIENT_PARTNER_ADVANCES", `سلف الشريك (${adv}) لا تكفي للتسوية (${base})`);
      jl.push({ account: "2300", debit: base, partnerId: partner, memo: `تسوية موثقة: ${e.settlement_note}` }, { account: "1250", credit: base, partnerId: partner });
    }
  }
  const je = await postJournal(tx, actor, { date, sourceDocType: "expense", sourceDocId: id, memo: `مصروف ${docNo}: ${e.description}`, lines: jl });
  const [h] = await tx`UPDATE expenses SET status = 'POSTED', doc_no = ${docNo}, amount_base = ${base.toString()}, posted_by = ${who.userId}, posted_at = now(), journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, doc_no AS "docNo", status`;
  await audit(tx, actor, { action: "expense.post", entityType: "expense", entityId: id, after: { docNo, base: base.toString(), mode: e.payment_mode } });
  return h!;
}

export async function reverseExpense(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [e] = await tx`SELECT * FROM expenses WHERE id = ${id} FOR UPDATE`;
  if (!e) throw notFound();
  if (e.status !== "POSTED") throw conflict("NOT_POSTED");
  if ((await tx`SELECT 1 FROM expense_payments WHERE expense_id = ${id} AND status = 'POSTED'`).length) throw conflict("HAS_PAYMENTS", "توجد دفعات مرحّلة؛ اعكسها أولاً");
  await reverseEntry(tx, actor, e.journal_entry_id, new Date().toISOString().slice(0, 10), `عكس مصروف ${e.doc_no}: ${reason}`);
  if (e.payment_mode === "PAID_CASH") await reverseCashMovements(tx, "expense", id);
  await tx`UPDATE expenses SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "expense.reverse", entityType: "expense", entityId: id, reason });
  return { id, status: "REVERSED" };
}

// =========================== payments of accrued / partner-payable expenses ===========================
export const expensePaymentSchema = z.object({ expenseId: uuid, docDate: dateStr, cashAccountId: uuid, amount: moneyStr, exchangeRate: rateStr.nullish() });

/** Pays a liability: Dr 2210 (accrued) or 2300 (owed to partner), Cr cash. It never creates a second expense. */
export async function payExpense(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof expensePaymentSchema>) {
  const [e] = await tx`SELECT * FROM expenses WHERE id = ${i.expenseId} FOR UPDATE`;
  if (!e || e.status !== "POSTED") throw conflict("EXPENSE_NOT_POSTED");
  const fin = await expenseOutstanding(tx, e.id);
  if (d(fin.outstanding).lte(0)) throw conflict("NOTHING_DUE", "لا مستحق على هذا المصروف");
  if (d(i.amount).gt(fin.outstanding)) throw conflict("OVER_PAYMENT", `المبلغ يتجاوز المستحق (${fin.outstanding})`);
  const c = await cashRow(tx, i.cashAccountId);
  if (!c || c.currency !== e.currency) throw badRequest("CASH_CURRENCY_MISMATCH", "عملة الصندوق يجب أن تطابق عملة المصروف");
  await assertCashAvailable(tx, i.cashAccountId, i.amount);
  const payRate = await resolveRate(tx, e.currency, i.docDate, i.exchangeRate ?? undefined);
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'expense_payment', ${yearOf(i.docDate)}) AS n`)[0]!.n as string;
  const partner = e.payment_mode === "PAID_BY_PARTNER" ? await partnerOf(tx, "PARTNER") : null;
  const st = settleLiability({ liabilityAccount: e.payment_mode === "ACCRUED" ? "2210" : "2300", cashAccount: c.code, currency: e.currency, amount: i.amount, bookedRate: e.exchange_rate_snapshot, paymentRate: payRate, partnerId: partner });
  const base = st.cashBase;
  const [p] = await tx`INSERT INTO expense_payments(company_id, draft_ref, doc_date, expense_id, cash_account_id, amount, amount_base, exchange_rate_snapshot, fx_diff_base, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${i.docDate}, ${e.id}, ${i.cashAccountId}, ${i.amount}, ${base.toString()}, ${payRate}, ${st.diff.toString()}, ${who.userId}) RETURNING id`;
  const je = await postJournal(tx, actor, { date: i.docDate, sourceDocType: "expense_payment", sourceDocId: p!.id, memo: `سداد ${e.payment_mode === "ACCRUED" ? "مصروف مستحق" : "ذمة الشريك"} ${e.doc_no}`, lines: st.lines });
  await tx`UPDATE expense_payments SET status = 'POSTED', doc_no = ${docNo}, posted_by = ${who.userId}, posted_at = now(), journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${p!.id}`;
  await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${who.companyId}, ${c.id}, ${d(i.amount).neg().toString()}, ${base.neg().toString()}, 'expense_payment', ${p!.id})`;
  await audit(tx, actor, { action: "expense_payment.post", entityType: "expense_payment", entityId: p!.id, after: { docNo, amount: i.amount } });
  return { id: p!.id as string, docNo };
}
export async function reverseExpensePayment(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [p] = await tx`SELECT * FROM expense_payments WHERE id = ${id} FOR UPDATE`;
  if (!p) throw notFound();
  if (p.status !== "POSTED") throw conflict("NOT_POSTED");
  await reverseEntry(tx, actor, p.journal_entry_id, new Date().toISOString().slice(0, 10), `عكس سداد ${p.doc_no}: ${reason}`);
  await reverseCashMovements(tx, "expense_payment", id);
  await tx`UPDATE expense_payments SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "expense_payment.reverse", entityType: "expense_payment", entityId: id, reason });
  return { id, status: "REVERSED" };
}

// =========================== employees & payroll ===========================
export const employeeSchema = z.object({ name: z.string().min(2).max(120), jobTitle: z.string().max(80).nullish(), monthlySalary: moneyStr, currency: currencyCode });
export const listEmployees = (tx: Tx) => tx`SELECT id, name, job_title AS "jobTitle", monthly_salary::text AS "monthlySalary", currency, is_active AS "isActive", version FROM employees ORDER BY name`;
export async function createEmployee(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof employeeSchema>) {
  const [e] = await tx`INSERT INTO employees(company_id, name, job_title, monthly_salary, currency) VALUES (${who.companyId}, ${i.name}, ${i.jobTitle ?? null}, ${i.monthlySalary}, ${i.currency}) RETURNING id, name`;
  await audit(tx, actor, { action: "employee.create", entityType: "employee", entityId: e!.id, after: i });
  return e!;
}
export async function setEmployeeActive(tx: Tx, actor: Actor, id: string, active: boolean) {
  const [e] = await tx`UPDATE employees SET is_active = ${active}, version = version + 1 WHERE id = ${id} RETURNING id, is_active AS "isActive"`;
  if (!e) throw notFound();
  await audit(tx, actor, { action: "employee.set_active", entityType: "employee", entityId: id, after: { active } });
  return e;
}

const monthStart = (m: string) => `${m}-01`;
export const generateSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });

/** One DRAFT accrual per active employee that has none for the month (never duplicates). */
export async function generateAccruals(tx: Tx, who: Principal, actor: Actor, month: string) {
  const emps = await tx`SELECT * FROM employees WHERE is_active AND monthly_salary > 0 AND NOT EXISTS (SELECT 1 FROM payroll_accruals a WHERE a.employee_id = employees.id AND a.period_month = ${monthStart(month)} AND a.status <> 'REVERSED')`;
  const created: string[] = []; const skipped: { name: string; reason: string }[] = [];
  for (const e of emps) {
    let rate: string; try { rate = await resolveRate(tx, e.currency, monthStart(month)); } catch { skipped.push({ name: e.name, reason: "NO_FX_RATE" }); continue; }
    const [a] = await tx`INSERT INTO payroll_accruals(company_id, employee_id, period_month, currency, exchange_rate_snapshot, amount, created_by) VALUES (${who.companyId}, ${e.id}, ${monthStart(month)}, ${e.currency}, ${rate}, ${e.monthly_salary}, ${who.userId}) RETURNING id`;
    created.push(a!.id as string);
  }
  await audit(tx, actor, { action: "payroll.generate", entityType: "payroll", after: { month, created: created.length, skipped } });
  return { created: created.length, skipped };
}

export async function listAccruals(tx: Tx, month?: string) {
  return tx`SELECT a.id, e.name AS employee, a.period_month::text AS month, a.currency, a.amount::text AS amount, a.status,
      (a.amount - COALESCE((SELECT sum(p.amount) FROM payroll_payments p WHERE p.accrual_id = a.id AND p.status = 'POSTED'), 0))::text AS outstanding
    FROM payroll_accruals a JOIN employees e ON e.id = a.employee_id WHERE (${month ? monthStart(month) : null}::date IS NULL OR a.period_month = ${month ? monthStart(month) : null}) ORDER BY a.period_month DESC, e.name`;
}

/** Salary is an expense of the month even if unpaid: Dr 6200 / Cr 2200. */
export async function postAccrual(tx: Tx, who: Principal, actor: Actor, id: string) {
  const [a] = await tx`SELECT a.*, e.name FROM payroll_accruals a JOIN employees e ON e.id = a.employee_id WHERE a.id = ${id} FOR UPDATE OF a`;
  if (!a) throw notFound();
  if (a.status !== "DRAFT") throw conflict("NOT_DRAFT");
  const date = dateOf(a.period_month), base = toBase(a.amount, a.exchange_rate_snapshot, a.currency);
  const je = await postJournal(tx, actor, { date, sourceDocType: "payroll_accrual", sourceDocId: id, memo: `استحقاق راتب ${a.name} — ${date.slice(0, 7)}`,
    lines: [{ account: "6200", debit: base, currency: a.currency, amountOrig: a.amount, fx: a.exchange_rate_snapshot }, { account: "2200", credit: base, currency: a.currency, amountOrig: a.amount, fx: a.exchange_rate_snapshot }] });
  await tx`UPDATE payroll_accruals SET status = 'POSTED', amount_base = ${base.toString()}, posted_by = ${who.userId}, posted_at = now(), journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "payroll.accrue", entityType: "payroll_accrual", entityId: id, after: { base: base.toString() } });
  return { id, status: "POSTED" };
}
export async function deleteAccrualDraft(tx: Tx, actor: Actor, id: string) {
  const [a] = await tx`SELECT status FROM payroll_accruals WHERE id = ${id} FOR UPDATE`;
  if (!a) throw notFound();
  if (a.status !== "DRAFT") throw conflict("NOT_DRAFT", "الحذف للمسودات فقط");
  await tx`DELETE FROM payroll_accruals WHERE id = ${id}`;
  await audit(tx, actor, { action: "payroll.delete_draft", entityType: "payroll_accrual", entityId: id });
}
export const payrollPaySchema = z.object({ accrualId: uuid, docDate: dateStr, cashAccountId: uuid, amount: moneyStr, exchangeRate: rateStr.nullish() });

/** Paying a salary reduces the liability (Dr 2200 / Cr cash); it is NOT a new expense. */
export async function payAccrual(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof payrollPaySchema>) {
  const [a] = await tx`SELECT * FROM payroll_accruals WHERE id = ${i.accrualId} FOR UPDATE`;
  if (!a || a.status !== "POSTED") throw conflict("ACCRUAL_NOT_POSTED", "رحّل الاستحقاق أولاً");
  const paid = (await tx`SELECT COALESCE(sum(amount), 0)::text AS p FROM payroll_payments WHERE accrual_id = ${a.id} AND status = 'POSTED'`)[0]!.p as string;
  if (d(i.amount).gt(d(a.amount).minus(paid))) throw conflict("OVER_PAYMENT", `المبلغ يتجاوز المتبقي (${d(a.amount).minus(paid)})`);
  const c = await cashRow(tx, i.cashAccountId);
  if (!c || c.currency !== a.currency) throw badRequest("CASH_CURRENCY_MISMATCH");
  await assertCashAvailable(tx, i.cashAccountId, i.amount);
  const payRate = await resolveRate(tx, a.currency, i.docDate, i.exchangeRate ?? undefined);
  const st = settleLiability({ liabilityAccount: "2200", cashAccount: c.code, currency: a.currency, amount: i.amount, bookedRate: a.exchange_rate_snapshot, paymentRate: payRate });
  const base = st.cashBase;
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'payroll_payment', ${yearOf(i.docDate)}) AS n`)[0]!.n as string;
  const [p] = await tx`INSERT INTO payroll_payments(company_id, accrual_id, cash_account_id, doc_no, doc_date, amount, amount_base, exchange_rate_snapshot, fx_diff_base, created_by) VALUES (${who.companyId}, ${a.id}, ${i.cashAccountId}, ${docNo}, ${i.docDate}, ${i.amount}, ${base.toString()}, ${payRate}, ${st.diff.toString()}, ${who.userId}) RETURNING id`;
  const je = await postJournal(tx, actor, { date: i.docDate, sourceDocType: "payroll_payment", sourceDocId: p!.id, memo: `دفع راتب ${docNo}`, lines: st.lines });
  await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${who.companyId}, ${c.id}, ${d(i.amount).neg().toString()}, ${base.neg().toString()}, 'payroll_payment', ${p!.id})`;
  await audit(tx, actor, { action: "payroll.pay", entityType: "payroll_payment", entityId: p!.id, after: { docNo, amount: i.amount, je } });
  return { id: p!.id as string, docNo };
}
export async function reversePayrollPayment(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [p] = await tx`SELECT * FROM payroll_payments WHERE id = ${id} FOR UPDATE`;
  if (!p) throw notFound();
  if (p.status !== "POSTED") throw conflict("NOT_POSTED");
  const je = (await tx`SELECT id FROM journal_entries WHERE source_doc_type = 'payroll_payment' AND source_doc_id = ${id} AND reverses_entry_id IS NULL`)[0]!.id as string;
  await reverseEntry(tx, actor, je, new Date().toISOString().slice(0, 10), `عكس دفع راتب ${p.doc_no}: ${reason}`);
  await reverseCashMovements(tx, "payroll_payment", id);
  await tx`UPDATE payroll_payments SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "payroll.reverse_payment", entityType: "payroll_payment", entityId: id, reason });
  return { id, status: "REVERSED" };
}
export async function reverseAccrual(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [a] = await tx`SELECT * FROM payroll_accruals WHERE id = ${id} FOR UPDATE`;
  if (!a) throw notFound();
  if (a.status !== "POSTED") throw conflict("NOT_POSTED");
  if ((await tx`SELECT 1 FROM payroll_payments WHERE accrual_id = ${id} AND status = 'POSTED'`).length) throw conflict("HAS_PAYMENTS", "توجد دفعات؛ اعكسها أولاً");
  await reverseEntry(tx, actor, a.journal_entry_id, new Date().toISOString().slice(0, 10), `عكس استحقاق راتب: ${reason}`);
  await tx`UPDATE payroll_accruals SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "payroll.reverse_accrual", entityType: "payroll_accrual", entityId: id, reason });
  return { id, status: "REVERSED" };
}
void Decimal;
