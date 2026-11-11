import type { Tx } from "../db";
import { d } from "../money";
import { badRequest } from "../errors";
import { distributableLiquidity } from "./cash";
import { computeSettlement } from "./settlements";
import { inventoryReconciliation } from "./reports";

const iso = (x: Date) => x.toISOString().slice(0, 10);
export const defaultRange = () => { const t = new Date(), f = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)); return { from: iso(f), to: iso(t) }; };

/** Σ(debit − credit) in IQD for accounts matching codes/types, optionally date-bounded. */
async function net(tx: Tx, f: { codes?: string[]; types?: string[]; from?: string; to?: string }) {
  const [r] = await tx`SELECT COALESCE(sum(jl.debit_base - jl.credit_base), 0)::text AS v FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
    WHERE (${f.codes ? 1 : 0} = 0 OR a.code = ANY(${f.codes ?? []}::text[])) AND (${f.types ? 1 : 0} = 0 OR a.type = ANY(${f.types ?? []}::text[]))
      AND (${f.from ?? null}::date IS NULL OR je.entry_date >= ${f.from ?? null}) AND (${f.to ?? null}::date IS NULL OR je.entry_date <= ${f.to ?? null})`;
  return d(r!.v);
}

async function pnl(tx: Tx, from: string, to: string) {
  const gross = (await net(tx, { codes: ["4100"], from, to })).neg(), disc = await net(tx, { codes: ["4150"], from, to }), ret = await net(tx, { codes: ["4190"], from, to });
  const revenue = gross.minus(disc).minus(ret), cogs = await net(tx, { codes: ["5100"], from, to });
  const expenses = await net(tx, { types: ["EXPENSE"], from, to }), other = (await net(tx, { codes: ["5200"], from, to })).plus(await net(tx, { codes: ["7100"], from, to }));
  const [col] = await tx`SELECT COALESCE(sum(amount_base), 0)::text AS v FROM customer_receipts WHERE status = 'POSTED' AND kind = 'CASH' AND doc_date BETWEEN ${from} AND ${to}`;
  return { revenue: revenue.toString(), cogs: cogs.toString(), grossProfit: revenue.minus(cogs).toString(), expenses: expenses.toString(), otherItems: other.toString(),
    netProfit: revenue.minus(cogs).minus(expenses).minus(other).toString(), collections: String(col!.v) };
}

export async function dashboard(tx: Tx, q: { from?: string; to?: string }) {
  const r = { ...defaultRange(), ...Object.fromEntries(Object.entries(q).filter(([, v]) => v)) } as { from: string; to: string };
  if (r.from > r.to) throw badRequest("BAD_RANGE");
  const days = Math.trunc((Date.parse(r.to) - Date.parse(r.from)) / 86400000) + 1;   // whole days (UTC dates)
  const prevTo = iso(new Date(Date.parse(r.from) - 86400000)), prevFrom = iso(new Date(Date.parse(prevTo) - (days - 1) * 86400000));
  const [cur, prev] = [await pnl(tx, r.from, r.to), await pnl(tx, prevFrom, prevTo)];

  const capital = (await net(tx, { codes: ["3100"] })).neg();
  const [mainCash] = await tx`SELECT COALESCE(sum(jl.debit_base - jl.credit_base), 0)::text AS v FROM journal_lines jl JOIN cash_accounts ca ON ca.account_id = jl.account_id WHERE ca.counts_toward_available_cash`;
  const custody = await net(tx, { codes: ["1150"] });
  const invMain = await net(tx, { codes: ["1300"] }), invPartner = await net(tx, { codes: ["1310"] });
  const receivables = await net(tx, { codes: ["1200"] }), customerCredit = (await net(tx, { codes: ["2400"] })).neg();
  const payables = (await net(tx, { codes: ["2100"] })).neg(), accrued = (await net(tx, { codes: ["2200", "2210"] })).neg(), partnerPayable = (await net(tx, { codes: ["2300"] })).neg();
  const dueProfit = (await net(tx, { codes: ["2500"] })).neg();
  const [overdue] = await tx`SELECT COALESCE(sum(si.net_base - COALESCE((SELECT sum(a.amount) FROM receipt_allocations a JOIN customer_receipts cr ON cr.id = a.receipt_id WHERE a.invoice_id = si.id AND cr.status = 'POSTED'), 0) * si.exchange_rate_snapshot
      - COALESCE((SELECT sum(applied_orig) FROM sales_returns WHERE invoice_id = si.id AND status = 'POSTED'), 0) * si.exchange_rate_snapshot), 0)::text AS v FROM sales_invoices si WHERE si.status = 'POSTED' AND COALESCE(si.due_date, si.doc_date) < CURRENT_DATE`;

  // distributable profit RIGHT NOW (what a settlement through today would release), 0 reserved
  let settlement: Record<string, string> | null = null;
  try { const last = (await tx`SELECT period_end::text AS pe FROM profit_settlements WHERE status = 'POSTED' ORDER BY period_end DESC LIMIT 1`)[0];
    const start = last ? iso(new Date(Date.parse(last.pe) + 86400000)) : "2000-01-01"; const c = await computeSettlement(tx, { periodStart: start, periodEnd: iso(new Date()), reserved: "0", releaseReserve: "0", adjustments: "0" });
    settlement = { eligibleProfit: c.eligibleProfit, deductions: c.deductions, distributable: c.distributable, ownerShare: c.ownerShare, partnerShare: c.partnerShare, lossCarriedIn: c.lossCarriedIn, lossCarriedOut: c.lossCarriedOut }; } catch { settlement = null; }
  const liq = await distributableLiquidity(tx);

  const months = await tx`WITH m AS (SELECT generate_series(date_trunc('month', CURRENT_DATE) - interval '11 months', date_trunc('month', CURRENT_DATE), interval '1 month')::date AS d)
    SELECT to_char(m.d, 'YYYY-MM') AS month,
      COALESCE(sum(CASE WHEN a.code = '4100' THEN jl.credit_base - jl.debit_base WHEN a.code IN ('4150','4190') THEN jl.credit_base - jl.debit_base END), 0)::text AS revenue,
      COALESCE(sum(CASE WHEN a.type = 'EXPENSE' THEN jl.debit_base - jl.credit_base END), 0)::text AS expenses,
      COALESCE(sum(CASE WHEN a.code = '5100' THEN jl.debit_base - jl.credit_base END), 0)::text AS cogs
    FROM m LEFT JOIN journal_entries je ON date_trunc('month', je.entry_date) = m.d LEFT JOIN journal_lines jl ON jl.entry_id = je.id LEFT JOIN accounts a ON a.id = jl.account_id GROUP BY m.d ORDER BY m.d`;
  const topProducts = await tx`SELECT p.code, p.name, sum(sl.qty_base)::text AS qty, sum(sl.net_line_base)::text AS revenue,
      COALESCE(sum((SELECT sum(dl.cost_base) FROM delivery_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_id WHERE dl.sales_line_id = sl.id AND dn.status = 'POSTED')), 0)::text AS cost
    FROM sales_lines sl JOIN sales_invoices si ON si.id = sl.invoice_id JOIN products p ON p.id = sl.product_id WHERE si.status = 'POSTED' AND si.doc_date BETWEEN ${r.from} AND ${r.to}
    GROUP BY p.code, p.name ORDER BY sum(sl.net_line_base) DESC LIMIT 5`;
  const topCustomers = await tx`SELECT c.name, sum(si.net_base)::text AS revenue FROM sales_invoices si JOIN contacts c ON c.id = si.customer_id WHERE si.status = 'POSTED' AND NOT si.is_opening AND si.doc_date BETWEEN ${r.from} AND ${r.to} GROUP BY c.name ORDER BY sum(si.net_base) DESC LIMIT 5`;
  const byCategory = await tx`SELECT ec.name, sum(jl.debit_base - jl.credit_base)::text AS amount FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
    LEFT JOIN expense_categories ec ON ec.account_id = a.id WHERE a.type = 'EXPENSE' AND je.entry_date BETWEEN ${r.from} AND ${r.to} GROUP BY ec.name, a.code ORDER BY sum(jl.debit_base - jl.credit_base) DESC LIMIT 8`;

  // accounting equation, always: assets = liabilities + equity + (revenues - costs). Must be exactly 0.
  const assets = await net(tx, { types: ["ASSET"] }), liabilities = (await net(tx, { types: ["LIABILITY"] })).neg(), equity = (await net(tx, { types: ["EQUITY"] })).neg();
  const income = (await net(tx, { types: ["REVENUE"] })).neg().minus(await net(tx, { types: ["COGS", "EXPENSE"] })).plus((await net(tx, { codes: ["7100"] })).neg());
  const diff = assets.minus(liabilities).minus(equity).minus(income);
  const recon = await inventoryReconciliation(tx);
  const delta = (a: string, b: string) => (d(b).isZero() ? null : d(a).minus(b).div(d(b).abs()).mul(100).toDecimalPlaces(1).toString());

  return { range: r, previousRange: { from: prevFrom, to: prevTo }, currency: "IQD",
    balances: { capital: capital.toString(), mainCash: String(mainCash!.v), partnerCustodyCash: custody.toString(), inventoryMain: invMain.toString(), inventoryPartner: invPartner.toString(), receivables: receivables.toString(), customerCredit: customerCredit.toString(),
      overdueReceivables: String(overdue!.v), supplierPayables: payables.toString(), accruedLiabilities: accrued.toString(), partnerPayable: partnerPayable.toString(), profitDueToPartners: dueProfit.toString() },
    period: cur, previous: prev, change: { revenue: delta(cur.revenue, prev.revenue), netProfit: delta(cur.netProfit, prev.netProfit), expenses: delta(cur.expenses, prev.expenses), collections: delta(cur.collections, prev.collections) },
    distributable: settlement, liquidity: { cash: liq.cash.toString(), committed: liq.committed.toString(), available: liq.available.toString() },
    series: months, topProducts, topCustomers, expensesByCategory: byCategory,
    integrity: { equationDifference: diff.toString(), balanced: diff.isZero(), inventoryReconciled: recon.ok } };
}

export async function alerts(tx: Tx) {
  const out: { level: "high" | "medium" | "info"; code: string; message: string; count?: number; amount?: string }[] = [];
  const [ar] = await tx`SELECT count(*)::int n, COALESCE(sum(x.o), 0)::text AS amt FROM (SELECT si.net - COALESCE((SELECT sum(a.amount) FROM receipt_allocations a JOIN customer_receipts cr ON cr.id = a.receipt_id WHERE a.invoice_id = si.id AND cr.status = 'POSTED'), 0)
      - COALESCE((SELECT sum(applied_orig) FROM sales_returns WHERE invoice_id = si.id AND status = 'POSTED'), 0) AS o FROM sales_invoices si WHERE si.status = 'POSTED' AND COALESCE(si.due_date, si.doc_date) < CURRENT_DATE) x WHERE x.o > 0`;
  if (ar!.n > 0) out.push({ level: "medium", code: "OVERDUE_RECEIVABLES", message: `${ar!.n} فاتورة بيع متأخرة السداد`, count: ar!.n, amount: ar!.amt });
  const [ap] = await tx`SELECT count(*)::int n, COALESCE(sum(po.total - COALESCE((SELECT sum(a.amount) FROM supplier_payment_allocations a JOIN supplier_payments sp ON sp.id = a.payment_id WHERE a.purchase_id = po.id AND sp.status = 'POSTED'), 0)), 0)::text AS amt
    FROM purchase_orders po WHERE po.status = 'POSTED' AND po.payment_type = 'CREDIT' AND po.due_date < CURRENT_DATE AND po.total > COALESCE((SELECT sum(a.amount) FROM supplier_payment_allocations a JOIN supplier_payments sp ON sp.id = a.payment_id WHERE a.purchase_id = po.id AND sp.status = 'POSTED'), 0)`;
  if (ap!.n > 0) out.push({ level: "medium", code: "OVERDUE_PAYABLES", message: `${ap!.n} فاتورة شراء مستحقة السداد للموردين`, count: ap!.n, amount: ap!.amt });
  const liq = await distributableLiquidity(tx);
  if (liq.available.lt(0)) out.push({ level: "high", code: "LIQUIDITY_SHORTFALL", message: "الالتزامات المقررة تتجاوز النقد المتاح", amount: liq.available.toString() });
  const [dr] = await tx`SELECT (SELECT count(*) FROM sales_invoices WHERE status = 'DRAFT' AND created_at < now() - interval '3 days') + (SELECT count(*) FROM purchase_orders WHERE status = 'DRAFT' AND created_at < now() - interval '3 days') + (SELECT count(*) FROM expenses WHERE status = 'DRAFT' AND created_at < now() - interval '3 days') AS n`;
  if (Number(dr!.n) > 0) out.push({ level: "info", code: "STALE_DRAFTS", message: `${dr!.n} مسودة قديمة (أكثر من 3 أيام) لم تُرحَّل`, count: Number(dr!.n) });
  const [pr] = await tx`SELECT count(*)::int n, COALESCE(sum(a.amount), 0)::text AS amt FROM payroll_accruals a WHERE a.status = 'POSTED' AND a.period_month < date_trunc('month', CURRENT_DATE) AND a.amount > COALESCE((SELECT sum(p.amount) FROM payroll_payments p WHERE p.accrual_id = a.id AND p.status = 'POSTED'), 0)`;
  if (pr!.n > 0) out.push({ level: "medium", code: "UNPAID_PAYROLL", message: `${pr!.n} راتب من أشهر سابقة غير مدفوع بالكامل`, count: pr!.n });
  const rec = await inventoryReconciliation(tx);
  if (!rec.ok) out.push({ level: "high", code: "INVENTORY_MISMATCH", message: "مخزون الطبقات لا يطابق دفتر الأستاذ — راجع فوراً" });
  const [neg] = await tx`SELECT count(*)::int n FROM (SELECT ca.id FROM cash_accounts ca JOIN journal_lines jl ON jl.account_id = ca.account_id GROUP BY ca.id HAVING sum(CASE WHEN jl.debit_base > 0 THEN jl.amount_orig ELSE -jl.amount_orig END) < 0) q`;
  if (neg!.n > 0) out.push({ level: "high", code: "NEGATIVE_CASH", message: "رصيد صندوق سالب (لا يجب أن يحدث)" });
  const [per] = await tx`SELECT 1 AS x FROM accounting_periods WHERE period_month = date_trunc('month', CURRENT_DATE - interval '1 month')::date AND status = 'CLOSED'`;
  if (!per && new Date().getUTCDate() > 10) out.push({ level: "info", code: "PERIOD_NOT_CLOSED", message: "الشهر الماضي لم يُقفل بعد" });
  return out;
}
