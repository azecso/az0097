import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import type { Principal } from "../authz";
import { badRequest, forbidden } from "../errors";

/** Effective-dated company settings (append-only history). A change applies from its date forward; it never re-interprets earlier days. */
export async function setSetting(tx: Tx, who: Principal, actor: Actor, key: string, value: unknown, o: { effectiveFrom?: string; reason: string }) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  const from = o.effectiveFrom ?? new Date().toISOString().slice(0, 10);
  if (from < new Date().toISOString().slice(0, 10)) throw badRequest("EFFECTIVE_DATE_IN_THE_PAST", "لا يجوز أن يسري الإعداد بأثر رجعي");
  const [r] = await tx`INSERT INTO setting_changes(company_id, key, value, effective_from, reason, changed_by) VALUES (${who.companyId}, ${key}, ${tx.json(value as never)}, ${from}, ${o.reason}, ${who.userId}) RETURNING id`;
  await audit(tx, actor, { action: "setting.change", entityType: "setting", entityId: null, after: { key, value, effectiveFrom: from, changeId: String(r!.id) }, reason: o.reason });
  return { key, value, effectiveFrom: from };
}

/** The value in force on `date` (latest change effective on or before it); `fallback` when none was ever recorded. */
export async function settingOn<T>(tx: Tx, key: string, date: string, fallback: T): Promise<T> {
  const [r] = await tx`SELECT value FROM setting_changes WHERE key = ${key} AND effective_from <= ${date} ORDER BY effective_from DESC, id DESC LIMIT 1`;
  return (r ? r.value : fallback) as T;
}
export const settingHistory = (tx: Tx, key: string) => tx`SELECT s.id::text AS id, s.value, s.effective_from::text AS "effectiveFrom", s.reason, u.username AS "changedBy", s.changed_at AS "changedAt" FROM setting_changes s JOIN users u ON u.id = s.changed_by WHERE s.key = ${key} ORDER BY s.effective_from DESC, s.id DESC`;
