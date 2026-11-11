import { NextRequest, NextResponse } from "next/server";
import { authenticate, fail } from "@/lib/http";
import { forbidden } from "@/lib/errors";
import { readPrepared } from "@/lib/services/reset";

/** The verified pre-reset copy (owner only). */
export async function GET(req: NextRequest) {
  try {
    const who = await authenticate(req); if (!who.isOwner) throw forbidden("OWNER_ONLY");
    const name = new URL(req.url).searchParams.get("file") ?? "";
    return new NextResponse(new Uint8Array(await readPrepared(name)), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
  } catch (e) { return fail(e); }
}
