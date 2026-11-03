import type { Tx } from "./db";

export interface Actor { userId: string | null; companyId: string; ip?: string | null; deviceId?: string | null }

export async function audit(tx: Tx, a: Actor, e: {
  action: string; entityType: string; entityId?: string | null;
  before?: unknown; after?: unknown; reason?: string | null;
}) {
  await tx`INSERT INTO audit_logs(company_id,user_id,device_id,ip,action,entity_type,entity_id,before_data,after_data,reason)
    VALUES (${a.companyId}, ${a.userId}, ${a.deviceId ?? null}, ${a.ip ?? null}, ${e.action}, ${e.entityType},
            ${e.entityId ?? null}, ${e.before === undefined ? null : tx.json(e.before as never)},
            ${e.after === undefined ? null : tx.json(e.after as never)}, ${e.reason ?? null})`;
}
