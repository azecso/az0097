import { z } from "zod";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, conflict, notFound } from "../errors";
import { d, toBase } from "../money";
import { postJournal, reverseEntry, type JLine } from "../ledger";
import { assertCashAvailable, reverseCashMovements } from "./cash";
import { dateStr, moneyStr, rateStr, resolveRate, uuid, yearOf } from "./common";

export const projectSchema = z.object({ name: z.string().trim().min(2).max(120), notes: z.string().max(500).nullish() });
export const entrySchema = z.object({ requestId: z.string().min(8).max(120), kind: z.enum(["SPEND", "REFUND"]), docDate: dateStr, cashAccountId: uuid, amount: moneyStr, exchangeRate: rateStr.nullish(), note: z.string().max(500).nullish() });

export async function createProject(tx: Tx, who: Principal, actor: Actor, i: z.infer<typeof projectSchema>) {
  const dup = await tx`SELECT 1 FROM projects WHERE lower(btrim(name)) = lower(btrim(${i.name}))`;
  if (dup.length) throw conflict("PROJECT_EXISTS", "يوجد مشروع بهذا الاسم");
  const [p] = await tx`INSERT INTO projects(company_id, name, notes, created_by) VALUES (${who.companyId}, ${i.name}, ${i.notes ?? null}, ${who.userId}) RETURNING id, name`;
  await audit(tx, actor, { action: "project.create", entityType: "project", entityId: p!.id as string, after: i });
  return p!;
}
const TOT = (tx: Tx, projectId: string | null) => tx`SELECT project_id AS "projectId", currency,
    COALESCE(sum(amount) FILTER (WHERE kind = 'SPEND'), 0)::text AS spent, COALESCE(sum(amount) FILTER (WHERE kind = 'REFUND'), 0)::text AS refunded,
    (COALESCE(sum(amount) FILTER (WHERE kind = 'SPEND'), 0) - COALESCE(sum(amount) FILTER (WHERE kind = 'REFUND'), 0))::text AS net, count(*)::int AS entries
  FROM project_entries WHERE status = 'POSTED' AND (${projectId}::uuid IS NULL OR project_id = ${projectId}::uuid) GROUP BY project_id, currency ORDER BY currency`;
export async function listProjects(tx: Tx) {
  const ps = await tx`SELECT id, name, notes, status, created_at AS "createdAt" FROM projects ORDER BY created_at DESC`;
  const tot = await TOT(tx, null);
  return ps.map((p) => ({ ...p, totals: tot.filter((t) => t.projectId === p.id).map(({ projectId: _x, ...t }) => t) }));
}
export async function getProject(tx: Tx, id: string) {
  const [p] = await tx`SELECT id, name, notes, status, version FROM projects WHERE id = ${id}`; if (!p) throw notFound();
  const entries = await tx`SELECT e.id, e.doc_no AS "docNo", e.doc_date::text AS "docDate", e.kind, e.currency, e.amount::text AS amount, e.note, e.status, ca.name AS "cashAccount", u.display_name AS "createdBy",
      (SELECT count(*)::int FROM attachments a WHERE a.entity_type = 'project_entry' AND a.entity_id = e.id) AS "photos"
    FROM project_entries e JOIN cash_accounts ca ON ca.id = e.cash_account_id JOIN users u ON u.id = e.created_by WHERE e.project_id = ${id} ORDER BY e.doc_date DESC, e.created_at DESC`;
  const totals = (await TOT(tx, id)).map(({ projectId: _x, ...t }) => t);
  return { ...p, entries, totals };
}

async function ensureProjectAccount(tx: Tx, companyId: string) {
  await tx`INSERT INTO accounts(company_id, code, name, type, normal_side, is_system) VALUES (${companyId}, '1700', 'تكاليف المشاريع (خارج أرباح الشراكة)', 'ASSET', 'DEBIT', true) ON CONFLICT (company_id, code) DO NOTHING`;
}

/**
 * Spend: the money leaves the chosen cash box at once (Dr 1700 project costs / Cr cash). Refund: money that came back reduces the project cost and returns to the box (Dr cash / Cr 1700).
 * Atomic and idempotent by requestId. 1700 is an asset account, so project costs never reduce (or enter) the partners' distributable profit.
 */
export async function addEntry(tx: Tx, who: Principal, actor: Actor, projectId: string, i: z.infer<typeof entrySchema>) {
  const { once } = await import("../idempotency");
  return once(tx, who, i.requestId, `project:${projectId}`, async () => {
    const amount = d(i.amount); if (amount.lte(0)) throw badRequest("INVALID_AMOUNT", "المبلغ يجب أن يكون موجباً");
    const [p] = await tx`SELECT status, name FROM projects WHERE id = ${projectId} FOR UPDATE`; if (!p) throw notFound();
    if (p.status !== "OPEN") throw conflict("PROJECT_CLOSED", "المشروع مغلق");
    const [ca] = await tx`SELECT ca.id, ca.currency, a.code FROM cash_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE ca.id = ${i.cashAccountId} AND ca.is_active`;
    if (!ca) throw badRequest("CASH_ACCOUNT_REQUIRED", "اختر الصندوق");
    const cur = ca.currency as string, fx = await resolveRate(tx, cur, i.docDate, i.exchangeRate ?? undefined), base = toBase(amount, fx, cur);
    if (i.kind === "REFUND") {                                                           // can never return more than the project actually cost (per currency)
      const [t] = await tx`SELECT (COALESCE(sum(amount) FILTER (WHERE kind = 'SPEND'), 0) - COALESCE(sum(amount) FILTER (WHERE kind = 'REFUND'), 0))::text AS net FROM project_entries WHERE project_id = ${projectId} AND currency = ${cur} AND status = 'POSTED'`;
      if (amount.gt(t!.net as string)) throw conflict("REFUND_EXCEEDS_COST", `المسترجع يتجاوز صافي ما صُرف على المشروع بعملة ${cur} (${t!.net})`);
    } else await assertCashAvailable(tx, ca.id as string, amount);
    await ensureProjectAccount(tx, who.companyId);
    await tx`INSERT INTO document_sequences(company_id, doc_type, fiscal_year, prefix) VALUES (${who.companyId}, 'project_entry', ${yearOf(i.docDate)}, 'PJ') ON CONFLICT DO NOTHING`;
    const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'project_entry', ${yearOf(i.docDate)}) AS n`)[0]!.n as string;
    const id = crypto.randomUUID(), spend = i.kind === "SPEND";
    const memo = `${spend ? "صرف على مشروع" : "استرجاع من مشروع"} «${p.name}» ${docNo}`;
    const jl: JLine[] = spend ? [{ account: "1700", debit: base, currency: cur, amountOrig: amount, fx, memo }, { account: ca.code as string, credit: base, currency: cur, amountOrig: amount, fx }]
      : [{ account: ca.code as string, debit: base, currency: cur, amountOrig: amount, fx }, { account: "1700", credit: base, currency: cur, amountOrig: amount, fx, memo }];
    const je = await postJournal(tx, actor, { date: i.docDate, sourceDocType: "project_entry", sourceDocId: id, memo, lines: jl });
    await tx`INSERT INTO project_entries(id, company_id, project_id, doc_no, doc_date, kind, cash_account_id, currency, exchange_rate_snapshot, amount, amount_base, note, journal_entry_id, created_by)
      VALUES (${id}, ${who.companyId}, ${projectId}, ${docNo}, ${i.docDate}, ${i.kind}, ${ca.id}, ${cur}, ${fx}, ${i.amount}, ${base.toString()}, ${i.note ?? null}, ${je}, ${who.userId})`;
    await tx`INSERT INTO cash_movements(company_id, cash_account_id, amount, amount_base, doc_type, doc_id) VALUES (${who.companyId}, ${ca.id}, ${(spend ? amount.neg() : amount).toString()}, ${(spend ? base.neg() : base).toString()}, 'project_entry', ${id})`;
    await audit(tx, actor, { action: `project_entry.${i.kind.toLowerCase()}`, entityType: "project_entry", entityId: id, after: { docNo, project: p.name, amount: i.amount, currency: cur, note: i.note ?? null } });
    return { id, docNo, kind: i.kind, currency: cur, amount: i.amount };
  });
}

export async function reverseEntryDoc(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const [e] = await tx`SELECT e.*, p.name AS pname FROM project_entries e JOIN projects p ON p.id = e.project_id WHERE e.id = ${id} FOR UPDATE OF e`; if (!e) throw notFound();
  if (e.status !== "POSTED") throw conflict("NOT_POSTED");
  if (e.kind === "SPEND") {                                                             // undoing a spend must not leave refunds larger than the remaining cost
    const [t] = await tx`SELECT (COALESCE(sum(amount) FILTER (WHERE kind = 'SPEND'), 0) - COALESCE(sum(amount) FILTER (WHERE kind = 'REFUND'), 0))::text AS net FROM project_entries WHERE project_id = ${e.project_id} AND currency = ${e.currency} AND status = 'POSTED'`;
    if (d(t!.net as string).minus(e.amount as string).lt(0)) throw conflict("REVERSE_BLOCKED_BY_REFUNDS", "توجد استرجاعات بعد هذا الصرف تتجاوز الباقي؛ أَلغِ الاسترجاعات أولاً");
  }
  await reverseEntry(tx, actor, e.journal_entry_id as string, new Date().toISOString().slice(0, 10), `عكس ${e.doc_no} مشروع «${e.pname}»: ${reason}`);
  await reverseCashMovements(tx, "project_entry", id);
  await tx`UPDATE project_entries SET status = 'REVERSED', version = version + 1, updated_at = now() WHERE id = ${id}`;
  await audit(tx, actor, { action: "project_entry.reverse", entityType: "project_entry", entityId: id, reason });
  return { id, status: "REVERSED" };
}
