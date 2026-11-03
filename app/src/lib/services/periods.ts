import { z } from "zod";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, conflict, forbidden } from "../errors";
import { requireStepUp } from "../stepup";
import { trialBalance } from "./reports";

export const periodSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), reason: z.string().min(3).max(300).optional(), totp: z.string().max(10).nullish() });
export const listPeriods = (tx: Tx) => tx`SELECT period_month::text AS month, status, closed_at AS "closedAt", reopened_at AS "reopenedAt", reopen_reason AS "reopenReason" FROM accounting_periods ORDER BY period_month DESC`;

export async function closePeriod(tx: Tx, who: Principal, actor: Actor, month: string) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  const first = `${month}-01`;
  const next = (await tx`SELECT (${first}::date + interval '1 month')::date::text AS n`)[0]!.n as string;
  if (next > new Date(Date.now() + 86400000).toISOString().slice(0, 10)) throw badRequest("PERIOD_NOT_FINISHED", "لا يمكن إقفال شهر لم ينتهِ بعد");
  const drafts = (await tx`SELECT (SELECT count(*) FROM sales_invoices WHERE status = 'DRAFT' AND doc_date >= ${first} AND doc_date < ${next})
      + (SELECT count(*) FROM purchase_orders WHERE status = 'DRAFT' AND doc_date >= ${first} AND doc_date < ${next})
      + (SELECT count(*) FROM expenses WHERE status = 'DRAFT' AND doc_date >= ${first} AND doc_date < ${next}) AS n`)[0]!.n;
  if (Number(drafts) > 0) throw conflict("DRAFTS_EXIST", `توجد ${drafts} مسودات مؤرخة في هذا الشهر؛ رحّلها أو احذفها قبل الإقفال`);
  const tb = await trialBalance(tx);
  const [p] = await tx`INSERT INTO accounting_periods(company_id, period_month, status, closed_by, closed_at, snapshot) VALUES (${who.companyId}, ${first}, 'CLOSED', ${who.userId}, now(), ${tx.json(tb as never)})
    ON CONFLICT (company_id, period_month) DO UPDATE SET status = 'CLOSED', closed_by = ${who.userId}, closed_at = now(), snapshot = ${tx.json(tb as never)} WHERE accounting_periods.status = 'OPEN' RETURNING period_month::text AS month, status`;
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
