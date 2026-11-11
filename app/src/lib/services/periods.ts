import { z } from "zod";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, conflict, forbidden } from "../errors";
import { requireStepUp } from "../stepup";
import { inventoryReconciliation, trialBalance } from "./reports";

export const periodSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), reason: z.string().min(3).max(300).optional(), totp: z.string().max(10).nullish() });
export const listPeriods = (tx: Tx) => tx`SELECT period_month::text AS month, status, closed_at AS "closedAt", reopened_at AS "reopenedAt", reopen_reason AS "reopenReason" FROM accounting_periods ORDER BY period_month DESC`;

export async function closePeriod(tx: Tx, who: Principal, actor: Actor, month: string) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  const first = `${month}-01`;
  const next = (await tx`SELECT (${first}::date + interval '1 month')::date::text AS n`)[0]!.n as string;
  if (next > new Date(Date.now() + 86400000).toISOString().slice(0, 10)) throw badRequest("PERIOD_NOT_FINISHED", "لا يمكن إقفال شهر لم ينتهِ بعد");
  // Serialise with posting: posts take the shared lock, closing takes it exclusively, so nothing can slip into the month while it closes.
  await tx`SELECT pg_advisory_xact_lock(hashtext(${who.companyId + ":period:" + month}))`;
  const range = (t: string, col = "doc_date", st = "'DRAFT'") => tx.unsafe(`SELECT count(*)::int AS n FROM ${t} WHERE status = ${st} AND ${col} >= '${first}' AND ${col} < '${next}'`);
  const pending: Record<string, number> = {};
  for (const [label, t] of [["sales_invoices", "sales_invoices"], ["purchase_orders", "purchase_orders"], ["expenses", "expenses"], ["customer_receipts", "customer_receipts"], ["supplier_payments", "supplier_payments"],
      ["delivery_notes", "delivery_notes"], ["sales_returns", "sales_returns"], ["purchase_returns", "purchase_returns"], ["cash_transfers", "cash_transfers"], ["stock_transfers", "stock_transfers"],
      ["inventory_counts", "inventory_counts"], ["expense_payments", "expense_payments"], ["personal_advances", "personal_advances"]] as const) {
    const n = ((await range(t)) as unknown as { n: number }[])[0]!.n; if (n > 0) pending[label] = n;
  }
  const acc = ((await tx.unsafe(`SELECT count(*)::int AS n FROM payroll_accruals WHERE status = 'DRAFT' AND period_month = '${first}'`)) as unknown as { n: number }[])[0]!.n; if (acc > 0) pending.payroll_accruals = acc;
  const cap = ((await tx.unsafe(`SELECT count(*)::int AS n FROM capital_transactions WHERE status IN ('REQUESTED','DRAFT') AND doc_date >= '${first}' AND doc_date < '${next}'`)) as unknown as { n: number }[])[0]!.n; if (cap > 0) pending.capital_transactions = cap;
  const open = ((await tx.unsafe(`SELECT count(*)::int AS n FROM profit_settlements WHERE status = 'DRAFT' AND period_end >= '${first}' AND period_end < '${next}'`)) as unknown as { n: number }[])[0]!.n; if (open > 0) pending.profit_settlements = open;
  const total = Object.values(pending).reduce((x, y) => x + y, 0);
  if (total > 0) throw conflict("DRAFTS_EXIST", `توجد ${total} مستندات معلّقة مؤرخة في هذا الشهر (${Object.entries(pending).map(([k, v]) => `${k}: ${v}`).join("، ")})؛ رحّلها أو احذفها قبل الإقفال`);
  const tb = await trialBalance(tx, `${(await tx`SELECT (${next}::date - 1)::text AS e`)[0]!.e}`);        // the snapshot is the ledger up to the LAST DAY of the month, never later movements
  if (!tb.balanced) throw conflict("TRIAL_BALANCE_UNBALANCED", "ميزان المراجعة حتى نهاية الشهر غير متوازن؛ لا يمكن الإقفال");
  const snapshot = { ...tb, reconciliation: { inventoryAsOfNow: await inventoryReconciliation(tx) } };
  const [p] = await tx`INSERT INTO accounting_periods(company_id, period_month, status, closed_by, closed_at, snapshot) VALUES (${who.companyId}, ${first}, 'CLOSED', ${who.userId}, now(), ${tx.json(snapshot as never)})
    ON CONFLICT (company_id, period_month) DO UPDATE SET status = 'CLOSED', closed_by = ${who.userId}, closed_at = now(), snapshot = ${tx.json(snapshot as never)} WHERE accounting_periods.status = 'OPEN' RETURNING period_month::text AS month, status`;
  if (!p) throw conflict("ALREADY_CLOSED", "الفترة مقفلة مسبقاً");
  await audit(tx, actor, { action: "period.close", entityType: "accounting_period", after: { month, balanced: tb.balanced } });
  return p;
}
export async function reopenPeriod(tx: Tx, who: Principal, actor: Actor, month: string, reason: string, totp?: string | null) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  await requireStepUp(tx, who, totp);
  const [p] = await tx`UPDATE accounting_periods SET status = 'OPEN', reopened_by = ${who.userId}, reopened_at = now(), reopen_reason = ${reason} WHERE period_month = ${`${month}-01`} AND status = 'CLOSED' RETURNING period_month::text AS month, status`;
  if (!p) throw conflict("NOT_CLOSED", "الفترة غير مقفلة");
  await audit(tx, actor, { action: "period.reopen", entityType: "accounting_period", reason, after: { month } });
  return p;
}
