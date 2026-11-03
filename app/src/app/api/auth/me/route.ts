import { NextRequest } from "next/server";
import { resolveSession, SESSION_COOKIE } from "@/lib/auth";
import { fail, json } from "@/lib/http";
import { unauthorized } from "@/lib/errors";
import { sql, withTenant } from "@/lib/db";

export async function GET(req: NextRequest) {
  try {
    const s = await resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
    if (!s) throw unauthorized();
    const perms = s.principal.isOwner ? "ALL" : await withTenant(s.principal.companyId, async (tx) =>
      (await tx`SELECT pm.resource, pm.action FROM user_permissions up JOIN permissions pm ON pm.id = up.permission_id WHERE up.user_id = ${s.principal.userId}`)
        .map((r) => `${r.resource}:${r.action}`), sql);
    return json({ companyId: s.principal.companyId, user: { username: s.principal.username, displayName: s.principal.displayName, isOwner: s.principal.isOwner }, csrf: s.csrf, permissions: perms });
  } catch (e) { return fail(e); }
}
