import { NextRequest, NextResponse } from "next/server";
import { logout, resolveSession, SESSION_COOKIE } from "@/lib/auth";
import { fail, sameOrigin } from "@/lib/http";
import { forbidden } from "@/lib/errors";
import { safeEqual } from "@/lib/crypto";

export async function POST(req: NextRequest) {
  try {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    const s = await resolveSession(token);
    if (s && token) {
      if (!sameOrigin(req)) throw forbidden("BAD_ORIGIN");
      const t = req.headers.get("x-csrf-token");
      if (!t || !safeEqual(t, s.csrf)) throw forbidden("BAD_CSRF");
      await logout(token);
    }
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  } catch (e) { return fail(e); }
}
