import { profitStepUpRequired, requireStepUp } from "../stepup";
import { z } from "zod";
import type { Tx } from "../db";
import type { Principal } from "../authz";
import type { Actor } from "../audit";
import { audit } from "../audit";
import { badRequest, conflict, forbidden } from "../errors";
import { d } from "../money";
import { dateStr, moneyStr } from "./common";
import { salesReport } from "./analytics";
import { approveSettlement, computeSettlement, createSettlementDraft, listPayouts, payProfit } from "./settlements";
import { distributableLiquidity } from "./cash";

const KINDS = ["OWNER", "PARTNER"] as const;
const nextDay = (s: string) => { const t = new Date(`${s}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);

export { profitStepUpRequired } from "../stepup";
export async function setProfitStepUp(tx: Tx, who: Principal, actor: Actor, on: boolean) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  await tx`UPDATE companies SET settings = jsonb_set(settings, '{profitStepUp}', ${on ? "true" : "false"}::jsonb), updated_at = now()`;
  await audit(tx, actor, { action: "company.profit_step_up", entityType: "company", entityId: who.companyId, after: { profitStepUp: on } });
  return { profitStepUp: on };
}

/** Live profit statement — nothing to type in. Capital is never touched: expenses reduce PROFIT; cash only moves when something is actually paid. */
export async function profitOverview(tx: Tx) {
  const [prev] = await tx`SELECT period_end::text AS pe FROM profit_settlements WHERE status = 'POSTED' ORDER BY period_end DESC LIMIT 1`;
  const periodStart = prev ? nextDay(prev.pe) : "2000-01-01";
  const periodEnd = [today(), periodStart].sort().pop()!;                                  // never before the start (a settlement already approved today)
  const live = await computeSettlement(tx, { periodStart, periodEnd, reserved: "0", releaseReserve: "0", adjustments: "0" });
  const exp = await tx`SELECT a.code, a.name, sum(jl.debit_base - jl.credit_base)::text AS amount
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
    WHERE (a.type = 'EXPENSE' OR a.code IN ('5200','7100')) AND je.entry_date <= ${periodEnd} AND (${prev?.pe ?? null}::date IS NULL OR je.entry_date > ${prev?.pe ?? null}::date)
    GROUP BY a.code, a.name HAVING sum(jl.debit_base - jl.credit_base) <> 0 ORDER BY a.code`;
  const byAccount = exp.map((r) => ({ code: r.code as string, name: r.name as string, amount: d(r.amount as string).toString() }));
  const listed = byAccount.reduce((s, r) => s.plus(r.amount), d(0));
  const other = d(live.deductions).minus(listed);                                          // entries dated before the last settlement but posted later
  const released = d((await tx`SELECT COALESCE(sum(l.newly_released), 0)::text AS v FROM profit_settlement_lines l JOIN profit_settlements s ON s.id = l.settlement_id WHERE s.status = 'POSTED'`)[0]!.v);
  const invoiced = ((await salesReport(tx, { group: "party" })).totals as Record<string, string | number>).profit as string;
  const partners = await tx`SELECT id, name, kind FROM partners ORDER BY kind DESC`;
  const people = [];
  for (const p of partners) {
    const [r] = await tx`SELECT
        COALESCE((SELECT sum(sh.share_amount) FROM profit_settlement_shares sh JOIN profit_settlements s ON s.id = sh.settlement_id WHERE sh.partner_id = ${p.id} AND s.status = 'POSTED'), 0)::text AS approved,
        COALESCE((SELECT sum(po.amount) FROM profit_payouts po WHERE po.partner_id = ${p.id} AND po.status = 'POSTED'), 0)::text AS paid,
        COALESCE((SELECT sum(po.advances_deducted) FROM profit_payouts po WHERE po.partner_id = ${p.id} AND po.status = 'POSTED'), 0)::text AS adv,
        COALESCE((SELECT sum(jl.debit_base - jl.credit_base) FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '3500' AND jl.partner_id = ${p.id}), 0)::text AS ext`;
    const pending = d(p.kind === "OWNER" ? live.ownerShare : live.partnerShare);
    const remainingApproved = d(r!.approved).minus(r!.paid);
    people.push({ kind: p.kind as string, name: p.name as string, approved: d(r!.approved as string).toString(), paid: d(r!.paid as string).toString(), advancesDeducted: d(r!.adv as string).toString(), externalDistributed: d(r!.ext as string).toString(), remainingApproved: remainingApproved.toString(), pending: pending.toString(), available: remainingApproved.plus(pending).toString() });
  }
  const liq = await distributableLiquidity(tx);
  return {
    period: { from: periodStart === "2000-01-01" ? null : periodStart, to: periodEnd },
    invoicedProfit: invoiced, collectedProfit: released.plus(live.eligibleProfit).plus(people.reduce((x, p) => x.plus(p.externalDistributed), d(0))).toString(), releasedBefore: released.toString(), newlyEligible: live.eligibleProfit,
    expenses: { total: live.deductions, byAccount, other: other.toString() }, lossCarriedIn: live.lossCarriedIn, lossCovered: live.lossCovered, netProfit: live.periodResult, distributable: live.distributable, lossCarriedOut: live.lossCarriedOut,
    externalDistributed: people.reduce((s, p) => s.plus(p.externalDistributed), d(0)).toString(),
    shares: { owner: live.ownerShare, partner: live.partnerShare }, people, liquidity: { cash: liq.cash.toString(), committed: liq.committed.toString(), available: liq.available.toString() },
    capital: d((await tx`SELECT COALESCE(sum(jl.credit_base - jl.debit_base), 0)::text AS v FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '3100'`)[0]!.v as string).toString(),
    payouts: await listPayouts(tx),
  };
}

export const withdrawSchema = z.object({ partnerKind: z.enum(KINDS), amount: moneyStr, cashAccountId: z.string().uuid(), docDate: dateStr, idempotencyKey: z.string().min(8).max(100), totp: z.string().max(10).nullish() });

/** Owner pays out PROFIT to one person. If the amount needs profit that is not yet approved, the live period is approved first (same engine, same checks); never touches capital. */
export async function withdrawProfit(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof withdrawSchema>) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  const amount = d(i.amount); if (amount.lte(0)) throw badRequest("INVALID_AMOUNT");
  await tx`SELECT pg_advisory_xact_lock(hashtext(${who.companyId + ":settlement"}))`;
  if (await profitStepUpRequired(tx)) await requireStepUp(tx, who, i.totp);                       // ONE verification for the whole request (approval + every payout)
  const ov = await profitOverview(tx); const me = ov.people.find((p) => p.kind === i.partnerKind)!;
  if (amount.gt(me.available)) throw conflict("EXCEEDS_PROFIT_SHARE", `المبلغ يتجاوز حصة ${me.name} من صافي الربح المتاح (${me.available})`);
  if (amount.gt(me.remainingApproved)) {                                                       // needs the live profit to be approved first
    const dft = await createSettlementDraft(tx, who, actor, { periodStart: ov.period.from ? ov.period.from : "2000-01-01", periodEnd: ov.period.to, reserved: "0", adjustments: "0", notes: "اعتماد تلقائي عند صرف الأرباح" } as never);
    await approveSettlement(tx, who, actor, (dft as unknown as { id: string }).id, i.totp ?? null, { stepUpDone: true });
  }
  const rows = await tx`SELECT s.id, sh.share_amount - COALESCE((SELECT sum(po.amount) FROM profit_payouts po WHERE po.settlement_id = s.id AND po.partner_id = sh.partner_id AND po.status = 'POSTED'), 0) AS rem
    FROM profit_settlement_shares sh JOIN profit_settlements s ON s.id = sh.settlement_id JOIN partners p ON p.id = sh.partner_id WHERE p.kind = ${i.partnerKind} AND s.status = 'POSTED' ORDER BY s.period_end, s.created_at`;
  let left = amount; const out: { id: string; docNo: string; amount: string }[] = [];
  for (const [n, r] of rows.entries()) {
    if (left.lte(0)) break; const rem = d(r.rem as string); if (rem.lte(0)) continue; const take = left.lt(rem) ? left : rem;
    const p = await payProfit(tx, who, actor, { settlementId: r.id as string, partnerKind: i.partnerKind, amount: take.toString(), deductAdvances: "0", cashAccountId: i.cashAccountId, docDate: i.docDate, idempotencyKey: `${i.idempotencyKey}:${n}`, totp: i.totp ?? null }, { stepUpDone: true });
    out.push({ id: p.id, docNo: p.docNo, amount: take.toString() }); left = left.minus(take);
  }
  if (left.gt(0)) throw conflict("EXCEEDS_PROFIT_SHARE", "تعذّر صرف كامل المبلغ من الحصة المعتمدة");
  return { payouts: out };
}
