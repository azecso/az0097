import type { Tx } from "../db";
import { d } from "../money";
import { inventoryReconciliation, trialBalance } from "./reports";

export interface RecCheck { code: string; title: string; ok: boolean; summary: string; rows: Record<string, string>[]; hint: string }

/**
 * Cross-checks every sub-ledger against the general ledger and says WHERE a difference is. Read-only; each check lists the offending rows.
 * A green screen proves the books agree with their own sub-ledgers — it does not prove the business facts are right (docs/ACCOUNTING_POLICY.md §9).
 */
export async function reconcile(tx: Tx): Promise<{ ok: boolean; checks: RecCheck[] }> {
  const checks: RecCheck[] = [];
  const add = (c: RecCheck) => checks.push(c);

  const tb = await trialBalance(tx);
  add({ code: "TRIAL_BALANCE", title: "ميزان المراجعة", ok: tb.balanced, summary: `مدين ${tb.totalDebit} / دائن ${tb.totalCredit}`, rows: [], hint: "كل قيد يجب أن يتوازن؛ فرق هنا يعني عطلاً في الترحيل" });

  const rec = await inventoryReconciliation(tx);
  add({ code: "INVENTORY", title: "المخزون (طبقات FIFO مقابل الأستاذ)", ok: rec.ok, summary: `الرئيسي: فرق ${rec.main.diff} • عهدة الشريك: فرق ${rec.partner.diff}`,
    rows: rec.ok ? [] : [{ الموقع: "الرئيسي", الطبقات: rec.main.lots, الأستاذ: rec.main.ledger, الفرق: rec.main.diff }, { الموقع: "عهدة الشريك", الطبقات: rec.partner.lots, الأستاذ: rec.partner.ledger, الفرق: rec.partner.diff }], hint: "قيمة الطبقات المتبقية يجب أن تساوي 1300/1310" });

  const cash = await tx`SELECT ca.name, ca.currency, COALESCE(g.v, 0)::text AS gl, COALESCE(m.v, 0)::text AS moves
    FROM cash_accounts ca
    LEFT JOIN (SELECT account_id, sum(CASE WHEN debit_base > 0 THEN amount_orig ELSE -amount_orig END) v FROM journal_lines GROUP BY account_id) g ON g.account_id = ca.account_id
    LEFT JOIN (SELECT cash_account_id, sum(amount) v FROM cash_movements GROUP BY cash_account_id) m ON m.cash_account_id = ca.id`;
  const cashBad = cash.filter((r) => !d(r.gl as string).eq(r.moves as string)).map((r) => ({ الحساب: r.name as string, العملة: r.currency as string, الأستاذ: r.gl as string, الحركات: r.moves as string, الفرق: d(r.gl as string).minus(r.moves as string).toString() }));
  add({ code: "CASH", title: "الصناديق (الأستاذ مقابل سجل الحركات)", ok: cashBad.length === 0, summary: `${cash.length} حساب، ${cashBad.length} فيها فرق`, rows: cashBad, hint: "كل حركة نقد يجب أن يقابلها قيد؛ قد يكون سبب الفرق مستند رُحّل خارج المسار الاعتيادي" });

  const ar = await tx`WITH gl AS (
      SELECT jl.contact_id, COALESCE(jl.currency, 'IQD') AS cur, sum(CASE WHEN jl.debit_base > 0 THEN jl.amount_orig ELSE -jl.amount_orig END) AS v
      FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '1200' AND jl.contact_id IS NOT NULL GROUP BY jl.contact_id, COALESCE(jl.currency, 'IQD')),
    sub AS (
      SELECT si.customer_id AS contact_id, si.currency AS cur, sum(si.net
        - COALESCE((SELECT sum(a.amount) FROM receipt_allocations a JOIN customer_receipts cr ON cr.id = a.receipt_id WHERE a.invoice_id = si.id AND cr.status = 'POSTED'), 0)
        - COALESCE((SELECT sum(applied_orig) FROM sales_returns WHERE invoice_id = si.id AND status = 'POSTED'), 0)) AS v
      FROM sales_invoices si WHERE si.status = 'POSTED' GROUP BY si.customer_id, si.currency)
    SELECT c.name, COALESCE(gl.cur, sub.cur) AS cur, COALESCE(gl.v, 0)::text AS gl, COALESCE(sub.v, 0)::text AS sub
    FROM gl FULL JOIN sub ON sub.contact_id = gl.contact_id AND sub.cur = gl.cur JOIN contacts c ON c.id = COALESCE(gl.contact_id, sub.contact_id)`;
  const arBad = ar.filter((r) => !d(r.gl as string).eq(r.sub as string)).map((r) => ({ العميل: r.name as string, العملة: r.cur as string, الأستاذ: r.gl as string, الفواتير: r.sub as string, الفرق: d(r.gl as string).minus(r.sub as string).toString() }));
  add({ code: "RECEIVABLES", title: "ذمم العملاء (الأستاذ 1200 مقابل الفواتير والسندات)", ok: arBad.length === 0, summary: `${ar.length} عميل/عملة، ${arBad.length} فيها فرق`, rows: arBad, hint: "الفرق يعني قبضاً أو مرتجعاً أو فاتورة لم تنعكس على الأخرى" });

  const [def] = await tx`SELECT COALESCE((SELECT sum(credit_base - debit_base) FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '2600'), 0)::text AS gl,
      COALESCE((SELECT sum(si.net_base) FROM sales_invoices si WHERE si.status = 'POSTED' AND si.revenue_deferred), 0)::text AS inv,
      COALESCE((SELECT sum(dl.revenue_net_base) FROM delivery_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_id JOIN sales_lines sl ON sl.id = dl.sales_line_id JOIN sales_invoices si ON si.id = sl.invoice_id
                WHERE dn.status = 'POSTED' AND si.status = 'POSTED' AND si.revenue_deferred), 0)::text AS rec`;
  const defExp = d(def!.inv).minus(def!.rec);
  add({ code: "DEFERRED_REVENUE", title: "الإيراد المؤجل (2600 = المفوتر غير المسلَّم)", ok: d(def!.gl).eq(defExp), summary: `الأستاذ ${def!.gl} • المتوقع ${defExp} (مفوتر ${def!.inv} − معترف به ${def!.rec})`, rows: d(def!.gl).eq(defExp) ? [] : [{ الأستاذ: def!.gl, المتوقع: defExp.toString() }], hint: "فاتورة بتسليم منفصل لم يُعترف بإيرادها كاملاً بعد" });

  const cr = await tx`SELECT c.name, COALESCE(jl.currency, 'IQD') AS cur, sum(jl.credit_base - jl.debit_base)::text AS base FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id JOIN contacts c ON c.id = jl.contact_id
      WHERE a.code = '2400' GROUP BY c.name, COALESCE(jl.currency, 'IQD') HAVING sum(jl.credit_base - jl.debit_base) < 0 OR sum(CASE WHEN jl.credit_base > 0 THEN jl.amount_orig ELSE -jl.amount_orig END) < 0`;
  add({ code: "CUSTOMER_CREDIT", title: "الأرصدة الدائنة للعملاء (لا تكون سالبة)", ok: cr.length === 0, summary: `${cr.length} رصيد سالب`, rows: cr.map((r) => ({ العميل: r.name as string, العملة: r.cur as string, الرصيد: r.base as string })), hint: "استُخدم رصيد دائن أكثر مما أُنشئ" });

  const pp = await tx`SELECT p.name, COALESCE((SELECT sum(jl.credit_base - jl.debit_base) FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '2500' AND jl.partner_id = p.id), 0)::text AS gl,
      (COALESCE((SELECT sum(sh.share_amount) FROM profit_settlement_shares sh JOIN profit_settlements s ON s.id = sh.settlement_id WHERE sh.partner_id = p.id AND s.status = 'POSTED'), 0)
       - COALESCE((SELECT sum(po.amount) FROM profit_payouts po WHERE po.partner_id = p.id AND po.status = 'POSTED'), 0))::text AS sub FROM partners p`;
  const ppBad = pp.filter((r) => !d(r.gl as string).eq(r.sub as string)).map((r) => ({ الشريك: r.name as string, الأستاذ: r.gl as string, الحصص_ناقص_الدفعات: r.sub as string, الفرق: d(r.gl as string).minus(r.sub as string).toString() }));
  add({ code: "PARTNER_PROFIT", title: "أرباح الشركاء المستحقة (2500 = الحصص المعتمدة − الدفعات)", ok: ppBad.length === 0, summary: `${pp.length} شريك، ${ppBad.length} فيها فرق`, rows: ppBad, hint: "فرق يعني تسوية أو دفعة لم تنعكس بشكل صحيح" });

  const [res] = await tx`SELECT COALESCE(sum(reserved - reserve_released), 0)::text AS v FROM profit_settlements WHERE status = 'POSTED'`;
  add({ code: "PROFIT_RESERVE", title: "رصيد حجز الأرباح (لا يكون سالباً)", ok: !d(res!.v).isNegative(), summary: `رصيد الحجز ${res!.v}`, rows: [], hint: "التحرير لا يتجاوز المحجوز" });

  const [om] = await tx`SELECT COALESCE((SELECT sum(debit_base - credit_base) FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '3600'), 0)::text AS gl,
      COALESCE((SELECT sum(round(a.amount * si.exchange_rate_snapshot)) FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id JOIN sales_invoices si ON si.id = a.invoice_id
                WHERE r.status = 'POSTED' AND a.external AND a.external_kind = 'OUTSIDE_MARGIN'), 0)::text AS sub`;
  add({ code: "OUTSIDE_MARGIN", title: "فرق الربح المستلم خارج الصندوق (3600 = تخصيصات السندات)", ok: d(om!.gl).eq(om!.sub as string), summary: `الأستاذ ${om!.gl} • السندات ${om!.sub}`, rows: d(om!.gl).eq(om!.sub as string) ? [] : [{ الأستاذ: om!.gl as string, السندات: om!.sub as string }], hint: "كل مبلغ خارج الصندوق يجب أن يقابله تخصيص في سند قبض مرحّل" });
  return { ok: checks.every((c) => c.ok), checks };
}
