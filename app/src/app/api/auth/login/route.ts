import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { login, SESSION_COOKIE, SESSION_HOURS } from "@/lib/auth";
import { clientIp, fail, sameOrigin } from "@/lib/http";
import { forbidden, AppError } from "@/lib/errors";
import { rateLimit } from "@/lib/ratelimit";

const body = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(256), totp: z.string().max(10).optional() });

export async function POST(req: NextRequest) {
  try {
    if (!sameOrigin(req)) throw forbidden("BAD_ORIGIN");
    const ip = clientIp(req) ?? "unknown";
    if (!rateLimit(`login:ip:${ip}`, Number(process.env.LOGIN_RATE_LIMIT ?? 10), 60_000)) throw new AppError(429, "RATE_LIMITED", "محاولات كثيرة، حاول لاحقاً");
    const b = body.parse(await req.json());
    const r = await login(b.username, b.password, b.totp, { ip: ip === "unknown" ? null : ip, ua: req.headers.get("user-agent"), deviceId: req.headers.get("x-device-id") });
    const res = NextResponse.json({ user: { username: r.principal.username, displayName: r.principal.displayName, isOwner: r.principal.isOwner }, csrf: r.csrf }, { headers: { "Cache-Control": "no-store" } });
    res.cookies.set(SESSION_COOKIE, r.token, { httpOnly: true, sameSite: "lax", secure: process.env.COOKIE_SECURE !== "false", path: "/", maxAge: SESSION_HOURS * 3600 });
    return res;
  } catch (e) { return fail(e); }
}
