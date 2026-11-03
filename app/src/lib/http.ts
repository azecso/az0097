import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { sql, withTenant, type Tx } from "./db";
import { AppError, forbidden, unauthorized } from "./errors";
import { resolveSession, SESSION_COOKIE } from "./auth";
import { require_, type Action, type Principal } from "./authz";
import { safeEqual } from "./crypto";
import { rateLimit } from "./ratelimit";
import type { Actor } from "./audit";

export interface Ctx { tx: Tx; principal: Principal; actor: Actor; req: NextRequest; params: Record<string, string> }
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const clientIp = (req: NextRequest) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;

/** Same-origin check: Origin (or Referer) host must match Host. Defense in depth next to the CSRF token. */
export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin") ?? req.headers.get("referer");
  if (!origin) return false;
  try { return new URL(origin).host === (req.headers.get("x-forwarded-host") ?? req.headers.get("host")); } catch { return false; }
}

export function json(data: unknown, status = 200) { return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } }); }

export function fail(e: unknown) {
  if (e instanceof AppError) return json({ error: { code: e.code, message: e.message } }, e.status);
  if (e instanceof ZodError) return json({ error: { code: "VALIDATION", message: "بيانات غير صالحة", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } }, 400);
  const pg = e as { code?: string; constraint_name?: string; message?: string };
  if (pg?.code === "23505") return json({ error: { code: "DUPLICATE", message: "القيمة موجودة مسبقاً" } }, 409);
  if (pg?.code === "P0001" && pg.message) return json({ error: { code: pg.message.split(/\s/)[0], message: "رفضت قاعدة البيانات العملية" } }, 409);
  console.error("[unhandled]", e);
  return json({ error: { code: "INTERNAL", message: "خطأ داخلي" } }, 500);
}

type Route = (req: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<NextResponse>;

/** Authenticated route: session → CSRF (mutations) → permission → tenant-scoped transaction. */
export function secured(opts: { perm?: [string, Action] | ((req: NextRequest) => [string, Action]); ownerOnly?: boolean },
                        fn: (c: Ctx) => Promise<unknown>): Route {
  return async (req, c) => {
    try {
      const s = await resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
      if (!s) throw unauthorized();
      if (!rateLimit(`api:${s.principal.userId}`, Number(process.env.API_RATE_LIMIT ?? 300), 60_000)) throw new AppError(429, "RATE_LIMITED", "طلبات كثيرة");
      if (MUTATING.has(req.method)) {
        if (!sameOrigin(req)) throw forbidden("BAD_ORIGIN");
        const t = req.headers.get("x-csrf-token");
        if (!t || !safeEqual(t, s.csrf)) throw forbidden("BAD_CSRF");
      }
      const params = await c.params;
      const result = await withTenant(s.principal.companyId, async (tx) => {
        if (opts.ownerOnly && !s.principal.isOwner) throw forbidden("OWNER_ONLY");
        const perm = typeof opts.perm === "function" ? opts.perm(req) : opts.perm;
        if (perm) await require_(tx, s.principal, perm[0], perm[1]);
        const actor: Actor = { userId: s.principal.userId, companyId: s.principal.companyId, ip: clientIp(req), deviceId: req.headers.get("x-device-id") };
        return fn({ tx, principal: s.principal, actor, req, params });
      });
      return json(result ?? { ok: true });
    } catch (e) { return fail(e); }
  };
}
export const parse = <T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> => schema.parse(data);
export { sql };
