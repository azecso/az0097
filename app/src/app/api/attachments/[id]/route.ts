import { NextRequest, NextResponse } from "next/server";
import { authenticate, clientIp, fail, json } from "@/lib/http";
import { withTenant } from "@/lib/db";
import { deleteAttachment, readAttachment } from "@/lib/services/attachments";

export async function GET(req: NextRequest, c: { params: Promise<{ id: string }> }) {
  try {
    const who = await authenticate(req); const { id } = await c.params;
    const { meta, data } = await withTenant(who.companyId, (tx) => readAttachment(tx, who, id));
    return new NextResponse(new Uint8Array(data), { headers: { "Content-Type": meta.mime_type as string, "Content-Length": String(data.length), "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.original_name as string)}`, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } });
  } catch (e) { return fail(e); }
}
export async function DELETE(req: NextRequest, c: { params: Promise<{ id: string }> }) {
  try { const who = await authenticate(req); const { id } = await c.params; return json(await withTenant(who.companyId, (tx) => deleteAttachment(tx, who, { userId: who.userId, companyId: who.companyId, ip: clientIp(req) }, id))); } catch (e) { return fail(e); }
}
