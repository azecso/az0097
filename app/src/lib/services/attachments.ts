import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import { can, type Principal } from "../authz";
import { badRequest, forbidden, notFound } from "../errors";

export const MAX_BYTES = 5 * 1024 * 1024;
const uploadDir = () => process.env.UPLOAD_DIR ?? join(process.cwd(), "data", "uploads");

/** The type is decided from the file's own bytes, never from the client-sent name or Content-Type. */
export function sniff(b: Buffer): { mime: string; ext: string } | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (b.length > 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  return null;
}

const RULE: Record<string, [string, "create" | "edit_draft"]> = {
  company_logo: ["company", "edit_draft"], company_signature: ["company", "edit_draft"], product: ["products", "create"],
  sales_invoice: ["sales", "create"], purchase_order: ["purchase", "create"], expense: ["expense", "create"], customer_receipt: ["voucher", "create"], supplier_payment: ["voucher", "create"],
};
export const ENTITY_TYPES = Object.keys(RULE);
const IMAGE_ONLY = new Set(["company_logo", "company_signature"]);

export async function saveAttachment(tx: Tx, who: Principal, actor: Actor, a: { entityType: string; entityId: string; name: string; data: Buffer }) {
  const rule = RULE[a.entityType];
  if (!rule) throw badRequest("BAD_ENTITY", "نوع الكيان غير مدعوم");
  if (!(await can(tx, who, rule[0], rule[1]))) throw forbidden(`FORBIDDEN:${rule[0]}:${rule[1]}`);
  if (a.data.length === 0 || a.data.length > MAX_BYTES) throw badRequest("FILE_SIZE", "الحجم يجب أن يكون بين 1 بايت و5MB");
  const t = sniff(a.data);
  if (!t) throw badRequest("FILE_TYPE", "الملف ليس صورة (PNG/JPEG/WebP) ولا PDF صالحاً");
  if (IMAGE_ONLY.has(a.entityType) && t.mime === "application/pdf") throw badRequest("FILE_TYPE", "الشعار والتوقيع صور فقط");
  if (a.entityType.startsWith("company_")) { if (a.entityId !== who.companyId) throw badRequest("BAD_ENTITY"); }
  else {
    const table = { product: "products", sales_invoice: "sales_invoices", purchase_order: "purchase_orders", expense: "expenses", customer_receipt: "customer_receipts", supplier_payment: "supplier_payments" }[a.entityType]!;
    if (!(await tx`SELECT 1 FROM ${tx(table)} WHERE id = ${a.entityId}`).length) throw notFound();       // RLS also scopes this to the tenant
  }
  const sha = createHash("sha256").update(a.data).digest("hex"), storage = `${sha}.${t.ext}`;           // content-addressed: no user-controlled path component
  const dir = join(uploadDir(), who.companyId); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, storage), a.data, { flag: "w", mode: 0o640 });
  const safeName = a.name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || "file";
  const [r] = await tx`INSERT INTO attachments(company_id, entity_type, entity_id, storage_name, original_name, sha256, mime_type, size_bytes, uploaded_by)
    VALUES (${who.companyId}, ${a.entityType}, ${a.entityId}, ${storage}, ${safeName}, ${sha}, ${t.mime}, ${a.data.length}, ${who.userId}) RETURNING id, mime_type AS mime, size_bytes AS size, original_name AS name`;
  if (a.entityType === "company_logo") await tx`UPDATE companies SET logo_attachment_id = ${r!.id}, version = version + 1, updated_at = now()`;
  if (a.entityType === "company_signature") await tx`UPDATE companies SET signature_attachment_id = ${r!.id}, version = version + 1, updated_at = now()`;
  await audit(tx, actor, { action: "attachment.upload", entityType: a.entityType, entityId: a.entityId, after: { attachmentId: r!.id, sha256: sha, size: a.data.length } });
  return r!;
}
export const listAttachments = (tx: Tx, entityType: string, entityId: string) =>
  tx`SELECT id, original_name AS name, mime_type AS mime, size_bytes AS size, uploaded_at AS "uploadedAt" FROM attachments WHERE entity_type = ${entityType} AND entity_id = ${entityId} AND NOT is_deleted ORDER BY uploaded_at`;

export async function readAttachment(tx: Tx, who: Principal, id: string) {
  const [a] = await tx`SELECT * FROM attachments WHERE id = ${id} AND NOT is_deleted`;
  if (!a) throw notFound();
  return { meta: a, data: await readFile(join(uploadDir(), who.companyId, a.storage_name as string)) };
}
export async function deleteAttachment(tx: Tx, who: Principal, actor: Actor, id: string) {
  const [a] = await tx`SELECT * FROM attachments WHERE id = ${id} AND NOT is_deleted`;
  if (!a) throw notFound();
  const rule = RULE[a.entity_type as string]!;
  if (!(await can(tx, who, rule[0], rule[1]))) throw forbidden();
  await tx`UPDATE attachments SET is_deleted = true WHERE id = ${id}`;
  if (a.entity_type === "company_logo") await tx`UPDATE companies SET logo_attachment_id = NULL WHERE logo_attachment_id = ${id}`;
  if (a.entity_type === "company_signature") await tx`UPDATE companies SET signature_attachment_id = NULL WHERE signature_attachment_id = ${id}`;
  await audit(tx, actor, { action: "attachment.delete", entityType: a.entity_type, entityId: a.entity_id, after: { attachmentId: id } });
  return { id };
}
