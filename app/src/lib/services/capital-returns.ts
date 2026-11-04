import { z } from "zod";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, conflict, notFound } from "../errors";
import { d } from "../money";
import { currencyCode, moneyStr, yearOf } from "./common";

/** Informational register only: no journal entry, no cash movement. Edits/deletes are allowed and fully audited. */
const stamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/, "تاريخ/وقت غير صالح");
export const capitalReturnSchema = z.object({
  returnedAt: stamp, currency: currencyCode, amount: moneyStr, recipientName: z.string().trim().min(2).max(120),
  refNo: z.string().trim().max(60).nullish(), method: z.enum(["CASH", "TRANSFER", "CHEQUE", "OTHER"]).default("CASH"), note: z.string().max(500).nullish(),
});
export const capitalReturnUpdateSchema = capitalReturnSchema.extend({ version: z.number().int() });
type In = z.infer<typeof capitalReturnSchema>;
const cols = (tx: Tx) => tx`c.id, c.doc_no AS "docNo", c.returned_at AS "returnedAt", c.currency, c.amount::text AS amount, c.recipient_name AS "recipientName", c.ref_no AS "refNo", c.method, c.note, c.version`;
const when = (s: string) => { const t = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(s) ? s : `${s}Z`); if (Number.isNaN(t.getTime())) throw badRequest("INVALID_DATE"); return t.toISOString(); };

export async function createCapitalReturn(tx: Tx, who: Principal, actor: Actor, i: In) {
  if (d(i.amount).lte(0)) throw badRequest("INVALID_AMOUNT");
  const at = when(i.returnedAt);
  const docNo = (await tx`SELECT next_document_number(${who.companyId}, 'capital_return', ${yearOf(at.slice(0, 10))}) AS n`)[0]!.n as string;
  const [r] = await tx`INSERT INTO capital_returns(company_id, doc_no, returned_at, currency, amount, recipient_name, ref_no, method, note, created_by)
    VALUES (${who.companyId}, ${docNo}, ${at}, ${i.currency}, ${i.amount}, ${i.recipientName}, ${i.refNo ?? null}, ${i.method}, ${i.note ?? null}, ${who.userId}) RETURNING id, doc_no AS "docNo"`;
  await audit(tx, actor, { action: "capital_return.create", entityType: "capital_return", entityId: r!.id, after: { ...i, docNo } });
  return r!;
}
export const listCapitalReturns = (tx: Tx, f: { from?: string; to?: string; q?: string } = {}) => tx`
  SELECT ${cols(tx)}, u.display_name AS "createdBy" FROM capital_returns c JOIN users u ON u.id = c.created_by
  WHERE (${f.from ?? null}::date IS NULL OR c.returned_at >= ${f.from ?? null}::date)
    AND (${f.to ?? null}::date IS NULL OR c.returned_at < (${f.to ?? null}::date + 1))
    AND (${f.q ?? null}::text IS NULL OR c.recipient_name ILIKE '%' || ${f.q ?? null} || '%' OR c.ref_no ILIKE '%' || ${f.q ?? null} || '%' OR c.doc_no ILIKE '%' || ${f.q ?? null} || '%')
  ORDER BY c.returned_at DESC, c.doc_no DESC LIMIT 500`;
export async function getCapitalReturn(tx: Tx, id: string) {
  const [r] = await tx`SELECT ${cols(tx)}, u.display_name AS "createdBy" FROM capital_returns c JOIN users u ON u.id = c.created_by WHERE c.id = ${id}`;
  if (!r) throw notFound(); return r;
}
export async function updateCapitalReturn(tx: Tx, who: Principal, actor: Actor, id: string, i: z.infer<typeof capitalReturnUpdateSchema>) {
  const before = await getCapitalReturn(tx, id);
  const [r] = await tx`UPDATE capital_returns SET returned_at = ${when(i.returnedAt)}, currency = ${i.currency}, amount = ${i.amount}, recipient_name = ${i.recipientName},
      ref_no = ${i.refNo ?? null}, method = ${i.method}, note = ${i.note ?? null}, version = version + 1, updated_at = now() WHERE id = ${id} AND version = ${i.version} RETURNING id, version`;
  if (!r) throw conflict("VERSION_CONFLICT", "تغيّر السجل منذ فتحه؛ أعد التحميل");
  await audit(tx, actor, { action: "capital_return.update", entityType: "capital_return", entityId: id, before, after: i });
  return r;
}
export async function deleteCapitalReturn(tx: Tx, who: Principal, actor: Actor, id: string, reason: string) {
  const before = await getCapitalReturn(tx, id);
  await tx`DELETE FROM capital_returns WHERE id = ${id}`;
  await audit(tx, actor, { action: "capital_return.delete", entityType: "capital_return", entityId: id, before, reason });
  return { deleted: true };
}
/** Totals per currency, optionally for a period — shown on the register and the report. */
export const capitalReturnTotals = (tx: Tx, f: { from?: string; to?: string } = {}) => tx`
  SELECT currency, sum(amount)::text AS total, count(*)::int AS n FROM capital_returns
  WHERE (${f.from ?? null}::date IS NULL OR returned_at >= ${f.from ?? null}::date) AND (${f.to ?? null}::date IS NULL OR returned_at < (${f.to ?? null}::date + 1)) GROUP BY currency ORDER BY currency`;
