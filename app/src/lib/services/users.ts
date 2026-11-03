import { z } from "zod";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import { assertStrongPassword, hashPassword } from "../auth";
import { DEFAULT_ACCOUNTANT_GRANTS, type Principal } from "../authz";
import { badRequest, conflict, forbidden, notFound } from "../errors";

export const createUserSchema = z.object({
  username: z.string().min(3).max(64).regex(/^[a-z0-9._-]+$/, "حروف لاتينية صغيرة وأرقام فقط"),
  displayName: z.string().min(2).max(120),
  password: z.string(),
});

export async function listUsers(tx: Tx) {
  return tx`SELECT id, username, display_name AS "displayName", is_owner AS "isOwner", status, version, created_at AS "createdAt"
            FROM users ORDER BY is_owner DESC, created_at`;
}

export async function createAccountant(tx: Tx, who: Principal, actor: Actor, input: z.infer<typeof createUserSchema>) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  assertStrongPassword(input.password);
  const pw = await hashPassword(input.password);
  const [u] = await tx`INSERT INTO users(company_id, username, display_name, password_hash, is_owner, created_by)
    VALUES (${who.companyId}, ${input.username}, ${input.displayName}, ${pw}, false, ${who.userId})
    RETURNING id, username, display_name AS "displayName", status, version`;
  const grants = DEFAULT_ACCOUNTANT_GRANTS;
  for (const [resource, action] of grants) {
    await tx`INSERT INTO user_permissions(user_id, permission_id, granted_by)
      SELECT ${u!.id}, id, ${who.userId} FROM permissions WHERE resource = ${resource} AND action = ${action} AND NOT owner_only
      ON CONFLICT DO NOTHING`;
  }
  await audit(tx, actor, { action: "user.create", entityType: "user", entityId: u!.id, after: { username: input.username, displayName: input.displayName } });
  return u!;
}

export const updateUserSchema = z.object({
  displayName: z.string().min(2).max(120).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  newPassword: z.string().optional(),
  version: z.number().int(),
});

export async function updateUser(tx: Tx, who: Principal, actor: Actor, id: string, input: z.infer<typeof updateUserSchema>) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  const [cur] = await tx`SELECT * FROM users WHERE id = ${id} FOR UPDATE`;
  if (!cur) throw notFound();
  if (cur.is_owner) throw badRequest("OWNER_IMMUTABLE", "لا يمكن تعديل حساب المالك من هنا");
  if (cur.version !== input.version) throw conflict("VERSION_CONFLICT", "تم تعديل السجل من جهة أخرى");
  const pw = input.newPassword ? (assertStrongPassword(input.newPassword), await hashPassword(input.newPassword)) : null;
  const [u] = await tx`UPDATE users SET display_name = ${input.displayName ?? cur.display_name},
      status = ${input.status ?? cur.status}, password_hash = ${pw ?? cur.password_hash},
      failed_logins = ${pw ? 0 : cur.failed_logins}, locked_until = ${pw ? null : cur.locked_until},
      version = version + 1, updated_at = now() WHERE id = ${id}
    RETURNING id, username, display_name AS "displayName", status, version`;
  if (input.status === "DISABLED" || pw) await tx`SELECT auth_revoke_user_sessions(${id})`;
  await audit(tx, actor, { action: "user.update", entityType: "user", entityId: id,
    before: { displayName: cur.display_name, status: cur.status }, after: { displayName: u!.displayName, status: u!.status, passwordChanged: !!pw } });
  return u!;
}

export async function getPermissions(tx: Tx, userId: string) {
  return tx`SELECT pm.resource, pm.action FROM user_permissions up JOIN permissions pm ON pm.id = up.permission_id
            WHERE up.user_id = ${userId} ORDER BY pm.resource, pm.action`;
}
export async function catalog(tx: Tx) {
  return tx`SELECT resource, action, owner_only AS "ownerOnly" FROM permissions ORDER BY resource, action`;
}

export const setPermsSchema = z.object({
  permissions: z.array(z.object({ resource: z.string().max(64), action: z.string().max(32) })).max(400),
});

/** Owner replaces an accountant's permission set. Owner-only permissions are rejected, never silently dropped. */
export async function setPermissions(tx: Tx, who: Principal, actor: Actor, userId: string, input: z.infer<typeof setPermsSchema>) {
  if (!who.isOwner) throw forbidden("OWNER_ONLY");
  const [target] = await tx`SELECT id, is_owner FROM users WHERE id = ${userId} FOR UPDATE`;
  if (!target) throw notFound();
  if (target.is_owner) throw badRequest("OWNER_IMMUTABLE");
  const cat = await tx`SELECT id, resource, action, owner_only FROM permissions`;
  const byKey = new Map(cat.map((c) => [`${c.resource}:${c.action}`, c]));
  const wanted = new Set<string>();
  for (const p of input.permissions) {
    const c = byKey.get(`${p.resource}:${p.action}`);
    if (!c) throw badRequest("UNKNOWN_PERMISSION", `${p.resource}:${p.action}`);
    if (c.owner_only) throw badRequest("OWNER_ONLY_PERMISSION", `${p.resource}:${p.action} للمالك حصراً`);
    wanted.add(c.id);
  }
  const before = await getPermissions(tx, userId);
  await tx`DELETE FROM user_permissions WHERE user_id = ${userId}`;
  for (const id of wanted) await tx`INSERT INTO user_permissions(user_id, permission_id, granted_by) VALUES (${userId}, ${id}, ${who.userId})`;
  const after = await getPermissions(tx, userId);
  await audit(tx, actor, { action: "user.permissions.set", entityType: "user", entityId: userId, before, after });
  return after;
}
