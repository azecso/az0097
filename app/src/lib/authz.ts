import type { Tx } from "./db";
import { forbidden } from "./errors";

export type Action = "view" | "create" | "edit_draft" | "approve" | "cancel" | "print" | "export";
export interface Principal { userId: string; companyId: string; isOwner: boolean; username: string; displayName: string }

/** Owner holds every permission. Everyone else needs an explicit user_permissions grant. */
export async function can(tx: Tx, p: Principal, resource: string, action: Action): Promise<boolean> {
  if (p.isOwner) return true;
  const r = await tx`SELECT 1 FROM user_permissions up JOIN permissions pm ON pm.id = up.permission_id
                     WHERE up.user_id = ${p.userId} AND pm.resource = ${resource} AND pm.action = ${action}`;
  return r.length > 0;
}
export async function require_(tx: Tx, p: Principal, resource: string, action: Action) {
  if (!(await can(tx, p, resource, action))) throw forbidden(`FORBIDDEN:${resource}:${action}`);
}

/** Default accountant template. Owner-only permissions are filtered out automatically. Owner can edit it. */
export const DEFAULT_ACCOUNTANT_GRANTS: ReadonlyArray<[string, Action]> = [
  ...(["contacts", "products", "purchase", "sales", "voucher", "stock_transfer", "inventory_count", "expense",
       "payroll", "capital", "capital_withdrawal", "personal", "opening_balance", "profit_settlement", "profit_payout", "fx_rate"] as const)
    .flatMap((r) => (["view", "create", "edit_draft", "print", "export"] as Action[]).map((a): [string, Action] => [r, a])),
  ...(["sales", "purchase", "voucher", "stock_transfer", "expense", "payroll", "fx_rate", "contacts", "products"] as const)
    .map((r): [string, Action] => [r, "approve"]),
  ["company", "view"], ["journal", "view"], ["journal", "print"], ["journal", "export"],
  ["report", "view"], ["report", "print"], ["report", "export"],
];
