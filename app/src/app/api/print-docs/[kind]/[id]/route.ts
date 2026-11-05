import { NextRequest, NextResponse } from "next/server";
import { authenticate, fail } from "@/lib/http";
import { withTenant } from "@/lib/db";
import { require_ } from "@/lib/authz";
import { badRequest } from "@/lib/errors";
import { getPrintDoc, PRINT_KINDS, PRINT_PERM, type PrintKind } from "@/lib/services/print-docs";

export async function GET(req: NextRequest, c: { params: Promise<{ kind: string; id: string }> }) {
  try {
    const who = await authenticate(req); const { kind, id } = await c.params;
    if (!(PRINT_KINDS as readonly string[]).includes(kind)) throw badRequest("UNKNOWN_DOC");
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw badRequest("BAD_ID");
    const data = await withTenant(who.companyId, async (tx) => { await require_(tx, who, PRINT_PERM[kind as PrintKind], "view"); return getPrintDoc(tx, kind as PrintKind, id); });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return fail(e); }
}
