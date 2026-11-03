import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticate, clientIp, fail, json } from "@/lib/http";
import { withTenant } from "@/lib/db";
import { badRequest } from "@/lib/errors";
import { listAttachments, saveAttachment, ENTITY_TYPES } from "@/lib/services/attachments";
import { rateLimit } from "@/lib/ratelimit";

export async function GET(req: NextRequest) {
  try {
    const who = await authenticate(req); const u = new URL(req.url);
    const q = z.object({ entityType: z.enum(ENTITY_TYPES as [string, ...string[]]), entityId: z.string().uuid() }).parse({ entityType: u.searchParams.get("entityType"), entityId: u.searchParams.get("entityId") });
    return json(await withTenant(who.companyId, (tx) => listAttachments(tx, q.entityType, q.entityId)));
  } catch (e) { return fail(e); }
}
export async function POST(req: NextRequest) {
  try {
    const who = await authenticate(req);
    if (!rateLimit(`upload:${who.userId}`, 30, 60_000)) throw badRequest("RATE_LIMITED", "رفع ملفات كثير");
    const len = Number(req.headers.get("content-length") ?? 0); if (len > 5.5 * 1024 * 1024) throw badRequest("FILE_SIZE", "الحجم الأقصى 5MB");
    const f = await req.formData(); const file = f.get("file");
    if (!(file instanceof File)) throw badRequest("NO_FILE");
    const q = z.object({ entityType: z.enum(ENTITY_TYPES as [string, ...string[]]), entityId: z.string().uuid() }).parse({ entityType: f.get("entityType"), entityId: f.get("entityId") });
    const data = Buffer.from(await file.arrayBuffer());
    return json(await withTenant(who.companyId, (tx) => saveAttachment(tx, who, { userId: who.userId, companyId: who.companyId, ip: clientIp(req) }, { ...q, name: file.name, data })));
  } catch (e) { return fail(e); }
}
