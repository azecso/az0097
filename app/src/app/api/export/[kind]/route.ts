import { NextRequest, NextResponse } from "next/server";
import { authenticate, fail } from "@/lib/http";
import { withTenant } from "@/lib/db";
import { require_ } from "@/lib/authz";
import { buildExport, EXPORT_KINDS, type ExportKind } from "@/lib/services/exports";
import { badRequest } from "@/lib/errors";

export async function GET(req: NextRequest, c: { params: Promise<{ kind: string }> }) {
  try {
    const who = await authenticate(req); const { kind } = await c.params;
    if (!(EXPORT_KINDS as readonly string[]).includes(kind)) throw badRequest("UNKNOWN_EXPORT");
    const { filename, buffer } = await withTenant(who.companyId, async (tx) => { await require_(tx, who, "report", "export"); return buildExport(tx, kind as ExportKind, new URL(req.url).searchParams.get("id"), new URL(req.url).searchParams); });
    return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" } });
  } catch (e) { return fail(e); }
}
