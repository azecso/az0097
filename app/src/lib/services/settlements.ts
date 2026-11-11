import { z } from "zod";
import Decimal from "decimal.js";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { d, split5050, toBase } from "../money";
import { postJournal, reverseEntry, type JLine } from "../ledger";
import { profitStepUpRequired, requireStepUp } from "../stepup";
import { assertCashAvailable, distributableLiquidity } from "./cash";
import { dateStr, draftRef, moneyStr, uuid, yearOf } from "./common";
import { invoiceProfit } from "./sales";

const dateOf = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const partnerRow = async (tx: Tx, kind: "OWNER" | "PARTNER") => (await tx`SELECT id, name FROM partners WHERE kind = ${kind}`)[0]!;

// ============================================================================================================
// Profit settlement. Definitions (see docs/phase-0/03 §8):
//   E  newly eligible profit = Σ over invoices (linked profit now − profit already released by earlier settlements)
//   X  deductions accrued since the previous settlement = cumulative ledger (expenses + inventory differences + FX) − previous cumulative
//   A  signed manual adjustment (documented)         R  amount the owner reserves (documented)         L  loss carried in
//   B = E − X + A ;  B<0 => loss carried out, D=0 ;  else cover=min(L,B), D = max(B − cover − R, 0), then 50/50 (partner floors, owner remainder)
// ============================================================================================================
export const settlementInput = z.object({ periodStart: dateStr, periodEnd: dateStr, reserved: moneyStr.default("0"), reservedReason: z.string().max(300).nullish(), releaseReserve: moneyStr.default("0"), releaseReason: z.string().max(300).nullish(), adjustmentReason: z.string().max(300).nullish(), adjustments: z.string().regex(/^-?\d{1,14}(\.\d{1,4})?$/).default("0"), notes: z.string().max(500).nullish() });

/** Reserve balance = everything the owner held back in approved settlements − everything released again (documented, never lost). */
export async function reserveBalance(tx: Tx) {
  const [r] = await tx`SELECT COALESCE(sum(reserved - reserve_released), 0)::text AS v FROM profit_settlements WHERE status = 'POSTED'`;
  return d(r!.v);
}

export async function computeSettlement(tx: Tx, i: z.infer<typeof settlementInput>) {
  if (i.periodEnd < i.periodStart) throw badRequest("BAD_PERIOD", "نهاية الفترة قبل بدايتها");
  if (d(i.reserved).gt(0) && !(i.reservedReason ?? "").trim()) throw badRequest("RESERVED_REASON_REQUIRED", "المبلغ المحجوز يتطلب سبباً مكتوباً");
  if (!d(i.adjustments).isZero() && (i.adjustmentReason ?? "").trim().length < 5) throw badRequest("ADJUSTMENT_REASON_REQUIRED", "التعديل اليدوي على الربح يتطلب سبباً مكتوباً (5 أحرف على الأقل)");
  const Rel = d(i.releaseReserve ?? "0");
  if (Rel.gt(0) && !(i.releaseReason ?? "").trim()) throw badRequest("RELEASE_REASON_REQUIRED", "تحرير مبلغ محجوز يتطلب سبباً مكتوباً");
  const [prev] = await tx`SELECT period_end::text AS pe, deductions_cum::text AS dc, loss_carried_out::text AS lco FROM profit_settlements WHERE status = 'POSTED' ORDER BY period_end DESC LIMIT 1`;
  if (prev && i.periodStart <= prev.pe) throw conflict("PERIOD_OVERLAP", `الفترة تتداخل مع تسوية معتمدة سابقة (تنتهي ${prev.pe})`);
  const resBefore = await reserveBalance(tx);
  if (Rel.gt(resBefore)) throw conflict("RELEASE_EXCEEDS_RESERVE", `المبلغ المطلوب تحريره يتجاوز رصيد الحجز (${resBefore})`);
  // Cut-off: only documents dated on or before periodEnd count. Later collections/deliveries/returns belong to a later settlement.
  const invs = await tx`SELECT id, doc_no FROM sales_invoices WHERE status = 'POSTED' AND NOT is_opening AND doc_date <= ${i.periodEnd} ORDER BY doc_date, doc_no`;
  const lines: { invoiceId: string; docNo: string; adjustedProfit: string; ratio: string; linked: string; before: string; newly: string; after: string }[] = [];
  let E = d(0);
  for (const inv of invs) {
    const p = await invoiceProfit(tx, inv.id, i.periodEnd);
    const before = d((await tx`SELECT COALESCE(sum(l.newly_released), 0)::text AS v FROM profit_settlement_lines l JOIN profit_settlements s ON s.id = l.settlement_id WHERE l.invoice_id = ${inv.id} AND s.status = 'POSTED'`)[0]!.v);
    // profit already distributed outside the system (receipt "external" allocations) is never distributed again; it counts only up to the cut-off
    const ext = d((await tx`SELECT COALESCE(sum(a.amount), 0)::text AS v FROM receipt_allocations a JOIN customer_receipts cr ON cr.id = a.receipt_id WHERE a.invoice_id = ${inv.id} AND a.external AND cr.status = 'POSTED' AND cr.doc_date <= ${i.periodEnd}`)[0]!.v);
    const linked = d(p.linkedProfitBase), room = Decimal.max(linked.minus(before), 0), newly = linked.minus(before).minus(Decimal.min(ext, room));
    if (newly.isZero()) continue;
    lines.push({ invoiceId: inv.id, docNo: inv.doc_no, adjustedProfit: p.adjustedProfitBase, ratio: p.collectedRatio, linked: linked.toString(), before: before.toString(), newly: newly.toString(), after: before.plus(newly).toString() });
    E = E.plus(newly);
  }
  const [led] = await tx`SELECT COALESCE(sum(jl.debit_base - jl.credit_base), 0)::text AS v FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
    WHERE (a.type = 'EXPENSE' OR a.code IN ('5200','7100')) AND je.entry_date <= ${i.periodEnd}`;
  const cumNow = d(led!.v), X = cumNow.minus(prev?.dc ?? 0), A = d(i.adjustments), L = d(prev?.lco ?? 0), R = d(i.reserved);
  const B = E.minus(X).plus(A).plus(Rel);
  let D = d(0), covered = d(0), Lout = L;
  if (B.lt(0)) Lout = L.plus(B.abs());
  else {
    covered = Decimal.min(L, B); Lout = L.minus(covered);
    const room = B.minus(covered);
    if (R.gt(room)) throw conflict("RESERVE_EXCEEDS_DISTRIBUTABLE", `المبلغ المحجوز (${R}) يتجاوز الربح القابل للتوزيع بعد تغطية الخسائر (${room})`);
    D = room.minus(R);
  }
  const sh = split5050(D, "IQD");
  const reserveAfter = resBefore.plus(B.lt(0) ? 0 : R).minus(Rel);
  return { eligibleProfit: E.toString(), deductions: X.toString(), deductionsCum: cumNow.toString(), adjustments: A.toString(), lossCarriedIn: L.toString(), reserved: B.lt(0) ? "0" : R.toString(), reserveReleased: Rel.toString(),
    reserveBefore: resBefore.toString(), reserveAfter: reserveAfter.toString(), periodResult: B.toString(),
    lossCovered: covered.toString(), lossCarriedOut: Lout.toString(), distributable: D.toString(), partnerShare: sh.partner.toString(), ownerShare: sh.owner.toString(), lines };
}

export const previewSettlement = (tx: Tx, i: z.infer<typeof settlementInput>) => computeSettlement(tx, i);

export async function createSettlementDraft(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof settlementInput>) {
  const c = await computeSettlement(tx, i);
  const [s] = await tx`INSERT INTO profit_settlements(company_id, draft_ref, period_start, period_end, eligible_profit, deductions, deductions_cum, adjustments, loss_carried_in, reserved, reserved_reason, loss_covered, loss_carried_out, distributable, reserve_released, reserve_release_reason, adjustment_reason, notes, created_by)
    VALUES (${who.companyId}, ${draftRef()}, ${i.periodStart}, ${i.periodEnd}, ${c.eligibleProfit}, ${c.deductions}, ${c.deductionsCum}, ${c.adjustments}, ${c.lossCarriedIn}, ${c.reserved}, ${i.reservedReason ?? null}, ${c.lossCovered}, ${c.lossCarriedOut}, ${c.distributable}, ${c.reserveReleased}, ${i.releaseReason ?? null}, ${i.adjustmentReason ?? null}, ${i.notes ?? null}, ${who.userId})
    RETURNING id, draft_ref AS "draftRef", version`;
  await audit(tx, actor, { action: "settlement.create_draft", entityType: "profit_settlement", entityId: s!.id, after: { ...i, preview: { distributable: c.distributable } } });
  return { ...s!, preview: c };
}
export async function deleteSettlementDraft(tx: Tx, actor: Actor, id: string) {
  const [s] = await tx`SELECT status FROM profit_settlements WHERE id = ${id} FOR UPDATE`;
  if (!s) throw notFound();
  if (s.status !== "DRAFT") throw conflict("NOT_DRAFT", "الحذف للمسودات فقط");
  await tx`DELETE FROM profit_settlements WHERE id = ${id}`;
  await audit(tx, actor, { action: "settlement.delete_draft", entityType: "profit_settlement", entityId: id });
}

export async function listSettlements(tx: Tx) {
  return tx`SELECT s.id, s.draft_ref AS "draftRef", s.doc_no AS "docNo", s.period_start::text AS "periodStart", s.period_end::text AS "periodEnd", s.status, s.eligible_profit::text AS "eligibleProfit", s.deductions::text AS deductions,
      s.adjustments::text AS adjustments, s.loss_carried_in::text AS "lossCarriedIn", s.reserved::text AS reserved, s.loss_covered::text AS "lossCovered", s.loss_carried_out::text AS "lossCarriedOut", s.distributable::text AS distributable,
      COALESCE((SELECT json_agg(json_build_object('partnerId', sh.partner_id, 'kind', p.kind, 'name', p.name, 'share', sh.share_amount::text,
         'paid', COALESCE((SELECT sum(po.amount) FROM profit_payouts po WHERE po.settlement_id = s.id AND po.partner_id = sh.partner_id AND po.status = 'POSTED'), 0)::text)) FROM profit_settlement_shares sh JOIN partners p ON p.id = sh.partner_id WHERE sh.settlement_id = s.id), '[]') AS shares
    FROM profit_settlements s ORDER BY s.period_end DESC, s.created_at DESC LIMIT 100`;
}

/** Owner approval: recomputes from the live books under a lock, freezes the lines (never reusable), books the distribution liability. */
/** `stepUpDone`: the caller (one request) already verified the TOTP code once; never consume the same code twice inside one request. */
export async function approveSettlement(tx: Tx, who: Principal, actor: Actor, id: string, totp?: string | null, opts: { stepUpDone?: boolean } = {}) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  if (!opts.stepUpDone && await profitStepUpRequired(tx)) await requireStepUp(tx, who, totp);
  await tx`SELECT pg_advisory_xact_lock(hashtext(${who.companyId + ":settlement"}))`;
  const [s] = await tx`SELECT * FROM profit_settlements WHERE id = ${id} FOR UPDATE`;
  if (!s) throw notFound();
  if (s.status !== "DRAFT") throw conflict("NOT_DRAFT", "التسوية ليست مسودة — لا يمكن اعتماد نفس التسوية مرتين");
  const c = await computeSettlement(tx, { periodStart: dateOf(s.period_start), periodEnd: dateOf(s.period_end), reserved: s.reserved, reservedReason: s.reserved_reason, releaseReserve: s.reserve_released, releaseReason: s.reserve_release_reason, adjustmentReason: s.adjustment_reason, adjustments: s.adjustments, notes: s.notes });
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'profit_settlement', ${yearOf(dateOf(s.period_end))}) AS n`)[0]!.n as string;
  for (const l of c.lines)
    await tx`INSERT INTO profit_settlement_lines(company_id, settlement_id, invoice_id, adjusted_profit, collected_ratio, linked_profit, released_before, newly_released, released_after)
      VALUES (${who.companyId}, ${id}, ${l.invoiceId}, ${l.adjustedProfit}, ${l.ratio}, ${l.linked}, ${l.before}, ${l.newly}, ${l.after})`;      // DB trigger: released_before must equal the true cumulative
  const owner = await partnerRow(tx, "OWNER"), partner = await partnerRow(tx, "PARTNER");
  await tx`INSERT INTO profit_settlement_shares(company_id, settlement_id, partner_id, share_amount) VALUES (${who.companyId}, ${id}, ${owner.id}, ${c.ownerShare}), (${who.companyId}, ${id}, ${partner.id}, ${c.partnerShare})`;
  let je: string | null = null;
  if (d(c.distributable).gt(0))
    je = await postJournal(tx, actor, { date: dateOf(s.period_end), sourceDocType: "profit_settlement", sourceDocId: id, memo: `تسوية أرباح ${docNo}`,
      lines: [{ account: "3400", debit: c.distributable }, { account: "2500", credit: c.ownerShare, partnerId: owner.id, memo: "حصة المالك" }, { account: "2500", credit: c.partnerShare, partnerId: partner.id, memo: "حصة الشريك" }] });
  const [h] = await tx`UPDATE profit_settlements SET status = 'POSTED', doc_no = ${docNo}, eligible_profit = ${c.eligibleProfit}, deductions = ${c.deductions}, deductions_cum = ${c.deductionsCum}, loss_carried_in = ${c.lossCarriedIn},
      loss_covered = ${c.lossCovered}, loss_carried_out = ${c.lossCarriedOut}, distributable = ${c.distributable}, reserved = ${c.reserved}, reserve_released = ${c.reserveReleased}, approved_by = ${who.userId}, approved_at = now(), journal_entry_id = ${je}, version = version + 1, updated_at = now() WHERE id = ${id} RETURNING id, doc_no AS "docNo", status`;
  await audit(tx, actor, { action: "settlement.approve", entityType: "profit_settlement", entityId: id, after: { docNo, ...c, lines: c.lines.length } });
  return { ...h!, ...c };
}

export async function reverseSettlement(tx: Tx, who: Principal, actor: Actor, id: string, reason: string, totp?: string | null) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  if (await profitStepUpRequired(tx)) await requireStepUp(tx, who, totp);
  await tx`SELECT pg_advisory_xact_lock(hashtext(${who.companyId + ":settlement"}))`;
  const [s] = await tx`SELECT * FROM profit_settlements WHERE id = ${id} FOR UPDATE`;
  if (!s) throw notFound();
  if (s.status !== "POSTED") throw conflict("NOT_POSTED");
  if ((await tx`SELECT 1 FROM profit_payouts WHERE settlement_id = ${id} AND status = 'POSTED'`).length) throw conflict("HAS_PAYOUTS", "توجد دفعات؛ اعكسها أولاً");
  if ((await tx`SELECT 1 FROM profit_settlements WHERE status = 'POSTED' AND period_end > ${dateOf(s.period_end)}`).length) throw conflict("NOT_LATEST", "اعكس التسويات الأحدث أولاً (بالترتيب العكسي)");
  const je = (await tx`SELECT id FROM journal_entries WHERE source_doc_type = 'profit_settlement' AND source_doc_id = ${id} AND reverses_entry_id IS NULL`)[0]?.id as string | undefined;
  if (je) await reverseEntry(tx, actor, je, new Date().toISOString().slice(0, 10), `عكس تسوية ${s.doc_no}: ${reason}`);
  await tx`UPDATE profit_settlements SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "settlement.reverse", entityType: "profit_settlement", entityId: id, reason });
  return { id, status: "REVERSED" };
}

// =========================== payouts ===========================
export const payoutSchema = z.object({ settlementId: uuid, partnerKind: z.enum(["OWNER", "PARTNER"]), amount: moneyStr, deductAdvances: moneyStr.default("0"), cashAccountId: uuid, docDate: dateStr, idempotencyKey: z.string().min(8).max(100), totp: z.string().max(10).nullish() });

export async function partnerAdvanceBalance(tx: Tx, partnerId: string) {
  return d((await tx`SELECT COALESCE(sum(jl.debit_base - jl.credit_base), 0)::text AS b FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '1250' AND jl.partner_id = ${partnerId}`)[0]!.b);
}

/** Pays part (or all) of a partner's approved share. Never exceeds the share, the cash, or cash minus committed obligations. Replays are refused. */
export async function payProfit(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof payoutSchema>, opts: { stepUpDone?: boolean } = {}) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  if (!opts.stepUpDone && await profitStepUpRequired(tx)) await requireStepUp(tx, who, i.totp);
  const [s] = await tx`SELECT * FROM profit_settlements WHERE id = ${i.settlementId} FOR UPDATE`;
  if (!s || s.status !== "POSTED") throw conflict("SETTLEMENT_NOT_APPROVED");
  const partner = await partnerRow(tx, i.partnerKind);
  const amount = d(i.amount), adv = d(i.deductAdvances);
  if (amount.lte(0)) throw badRequest("INVALID_AMOUNT");
  if ((await tx`SELECT 1 FROM profit_payouts WHERE idempotency_key = ${i.idempotencyKey}`).length) throw conflict("DUPLICATE_PAYOUT", "هذه الدفعة سُجّلت مسبقاً (مفتاح مكرر)");
  const cash = amount.minus(adv);
  if (adv.gt(amount)) throw badRequest("ADVANCES_EXCEED_PAYOUT");
  if (adv.gt(0)) { const bal = await partnerAdvanceBalance(tx, partner.id); if (adv.gt(bal)) throw conflict("ADVANCES_EXCEED_BALANCE", `سلف الشريك المتاحة للخصم ${bal}`); }
  const [ca] = await tx`SELECT ca.id, ca.currency, ca.counts_toward_available_cash AS ctr, a.code FROM cash_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = ${i.cashAccountId} AND ca.is_active`;
  if (!ca || ca.currency !== "IQD" || !ca.ctr) throw badRequest("BAD_CASH_ACCOUNT", "الدفع من صندوق/حساب دينار ضمن النقد المتاح");
  if (cash.gt(0)) {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${who.companyId + ":payout-liquidity"}))`;      // simultaneous payouts (even of different settlements) are checked one at a time against the same liquidity
    await assertCashAvailable(tx, i.cashAccountId, cash);
    const liq = await distributableLiquidity(tx);
    if (cash.gt(liq.available)) throw conflict("INSUFFICIENT_LIQUIDITY", `النقد المتاح للتوزيع بعد الالتزامات المقررة ${liq.available} (نقد ${liq.cash} − التزامات ${liq.committed})`);
  }
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'profit_payout', ${yearOf(i.docDate)}) AS n`)[0]!.n as string;
  const [p] = await tx`INSERT INTO profit_payouts(company_id, doc_no, doc_date, settlement_id, partner_id, amount, advances_deducted, cash_account_id, idempotency_key, paid_by)
    VALUES (${who.companyId}, ${docNo}, ${i.docDate}, ${i.settlementId}, ${partner.id}, ${amount.toString()}, ${adv.toString()}, ${i.cashAccountId}, ${i.idempotencyKey}, ${who.userId}) RETURNING id`;     // DB trigger: Σ payouts ≤ share
  const jl: JLine[] = [{ account: "2500", debit: amount, partnerId: partner.id }];
  if (cash.gt(0)) jl.push({ account: ca.code, credit: cash });
  if (adv.gt(0)) jl.push({ account: "1250", credit: adv, partnerId: partner.id, memo: "خصم سلف من الحصة" });
  const je = await postJournal(tx, actor, { date: i.docDate, sourceDocType: "profit_payout", sourceDocId: p!.id, memo: `دفعة أرباح ${docNo} — ${partner.name}`, lines: jl });
  if (cash.gt(0)) await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${who.companyId}, ${ca.id}, ${cash.neg().toString()}, ${cash.neg().toString()}, 'profit_payout', ${p!.id})`;
  await audit(tx, actor, { action: "profit_payout.pay", entityType: "profit_payout", entityId: p!.id, after: { docNo, partner: partner.name, amount: amount.toString(), cash: cash.toString(), advances: adv.toString(), je } });
  return { id: p!.id as string, docNo, paidCash: cash.toString(), advancesDeducted: adv.toString() };
}

export async function reversePayout(tx: Tx, who: Principal, actor: Actor, id: string, reason: string, totp?: string | null) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  if (await profitStepUpRequired(tx)) await requireStepUp(tx, who, totp);
  const [p] = await tx`SELECT * FROM profit_payouts WHERE id = ${id} FOR UPDATE`;
  if (!p) throw notFound();
  if (p.status !== "POSTED") throw conflict("NOT_POSTED");
  const je = (await tx`SELECT id FROM journal_entries WHERE source_doc_type = 'profit_payout' AND source_doc_id = ${id} AND reverses_entry_id IS NULL`)[0]!.id as string;
  await reverseEntry(tx, actor, je, new Date().toISOString().slice(0, 10), `عكس دفعة أرباح ${p.doc_no}: ${reason}`);
  await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) SELECT company_id, cash_account_id, abs(amount), abs(amount_base), 'profit_payout', doc_id FROM cash_movements WHERE doc_type = 'profit_payout' AND doc_id = ${id} AND amount < 0`;
  await tx`UPDATE profit_payouts SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "profit_payout.reverse", entityType: "profit_payout", entityId: id, reason });
  return { id, status: "REVERSED" };
}
export const listPayouts = (tx: Tx) => tx`SELECT po.id, po.doc_no AS "docNo", po.doc_date::text AS "docDate", p.name AS partner, p.kind AS "partnerKind", po.amount::text AS amount, po.advances_deducted::text AS "advancesDeducted", po.status, s.doc_no AS "settlementNo"
  FROM profit_payouts po JOIN partners p ON p.id = po.partner_id JOIN profit_settlements s ON s.id = po.settlement_id ORDER BY po.doc_date DESC, po.paid_at DESC LIMIT 200`;

// =========================== partner statement & liquidity ===========================
export async function partnersOverview(tx: Tx) {
  const ps = await tx`SELECT id, name, kind FROM partners ORDER BY kind DESC`;
  const out = [];
  for (const p of ps) {
    const [r] = await tx`SELECT
      COALESCE(sum(CASE WHEN a.code = '2500' THEN jl.credit_base - jl.debit_base END), 0)::text AS due_profit,
      COALESCE(sum(CASE WHEN a.code = '2300' THEN jl.credit_base - jl.debit_base END), 0)::text AS payable,
      COALESCE(sum(CASE WHEN a.code = '1250' THEN jl.debit_base - jl.credit_base END), 0)::text AS advances,
      COALESCE(sum(CASE WHEN a.code = '3100' THEN jl.credit_base - jl.debit_base END), 0)::text AS capital,
      COALESCE(sum(CASE WHEN a.code = '3200' THEN jl.debit_base - jl.credit_base END), 0)::text AS drawings
      FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.partner_id = ${p.id}`;
    out.push({ ...p, dueProfit: r!.due_profit, payableToPartner: r!.payable, advancesOutstanding: r!.advances, capital: r!.capital, ownerDrawings: r!.drawings,
      netDue: d(r!.due_profit).plus(r!.payable).minus(r!.advances).toString() });
  }
  return { partners: out, liquidity: await liquiditySummary(tx), reserveBalance: (await reserveBalance(tx)).toString(), lossCarriedForward: (await tx`SELECT COALESCE((SELECT loss_carried_out FROM profit_settlements WHERE status = 'POSTED' ORDER BY period_end DESC LIMIT 1), 0)::text AS v`)[0]!.v };
}
async function liquiditySummary(tx: Tx) { const l = await distributableLiquidity(tx); return { cash: l.cash.toString(), committed: l.committed.toString(), available: l.available.toString(), customerCredits: l.customerCredits, accruedLiabilities: l.accruedLiabilities, suppliersDue: l.suppliersDue, byCurrency: l.byCurrency }; }

export async function partnerStatement(tx: Tx, partnerId: string) {
  const [p] = await tx`SELECT id, name, kind FROM partners WHERE id = ${partnerId}`;
  if (!p) throw notFound();
  const lines = await tx`SELECT je.entry_date::text AS date, je.entry_no AS "entryNo", je.source_doc_type AS "docType", je.memo, a.code AS account, a.name AS "accountName", jl.debit_base::text AS debit, jl.credit_base::text AS credit
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id WHERE jl.partner_id = ${partnerId} ORDER BY je.entry_date, je.posted_at, jl.line_no`;
  let net = d(0);
  const rows = lines.map((l) => { const eff = ["2500", "2300"].includes(l.account) ? d(l.credit).minus(l.debit) : l.account === "1250" ? d(l.credit).minus(l.debit) : d(0); net = net.plus(eff); return { ...l, effectOnNetDue: eff.toString(), netDue: net.toString() }; });
  return { partner: p, lines: rows, netDue: net.toString() };
}
void toBase;
