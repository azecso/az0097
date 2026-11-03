import { NextRequest, NextResponse } from "next/server";
import { authenticate, fail } from "@/lib/http";
import { SESSION_COOKIE } from "@/lib/auth";
import { renderPdf } from "@/lib/pdf";
import { badRequest } from "@/lib/errors";

export const maxDuration = 60;
export async function GET(req: NextRequest) {
  try {
    await authenticate(req);
    const path = new URL(req.url).searchParams.get("path"); if (!path) throw badRequest("PATH_REQUIRED");
    const origin = `http://127.0.0.1:${process.env.PORT ?? 3000}`;                               // never a user-supplied host
    const pdf = await renderPdf(origin, path, req.cookies.get(SESSION_COOKIE)!.value);
    return new NextResponse(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${path.split("/").slice(-2).join("-").replace(/[^a-z0-9-]/gi, "")}.pdf"`, "Cache-Control": "no-store" } });
  } catch (e) { return fail(e); }
}
