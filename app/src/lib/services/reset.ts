import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import { AppError, badRequest, conflict } from "../errors";

export const RESET_PHRASE = "تصفير كل البيانات";
const uploadDir = () => process.env.UPLOAD_DIR ?? join(process.cwd(), "data", "uploads");
export const exportDir = () => process.env.EXPORT_DIR ?? join(uploadDir(), "..", "exports");
const MAX_EXPORT_BYTES = () => Number(process.env.RESET_EXPORT_MAX_MB ?? 200) * 1024 * 1024;
const MAX_PREPARED_AGE_MS = () => Number(process.env.RESET_PREPARED_MAX_MINUTES ?? 60) * 60_000;

/** Tables emptied by the reset (the database function truncates exactly these; tests assert the two stay in sync). Attachments are handled row-wise (logo/signature kept). */
export const WIPED_TABLES = ["accounting_periods", "capital_returns", "capital_transactions", "cash_movements", "cash_transfers", "contacts", "customer_receipts", "delivery_lines", "delivery_notes", "employees",
  "expense_payments", "expenses", "inventory_count_lines", "inventory_counts", "journal_entries", "journal_lines", "opening_balances", "payroll_accruals", "payroll_payments", "personal_advances", "personal_debts",
  "product_uoms", "products", "profit_payouts", "profit_settlement_lines", "profit_settlement_shares", "profit_settlements", "purchase_charges", "purchase_lines", "purchase_orders", "purchase_return_lines",
  "purchase_returns", "receipt_allocations", "sales_invoices", "sales_lines", "sales_quote_lines", "sales_quotes", "sales_return_lines", "sales_returns", "stock_lot_consumptions", "stock_lot_returns", "stock_lots",
  "stock_movements", "stock_transfer_lines", "stock_transfers", "supplier_payment_allocations", "supplier_payments", "sync_conflicts", "sync_operations"] as const;
/** Included in the export besides the wiped tables: rows that are kept but that a restore must put back (numbering, uploaded files' metadata). */
export const EXTRA_EXPORT_TABLES = ["attachments", "document_sequences"] as const;

export interface ExportFile { kind: "full-export"; version: 2; createdAt: string; companyId: string; tables: Record<string, unknown[]>; attachments: { storageName: string; companyId: string; sha256: string; dataBase64: string }[] }

/** A complete, restorable snapshot: every row of every table the reset touches, plus the uploaded files themselves. Restore: scripts/restore-export.ts. */
export async function buildExport(tx: Tx, companyId: string): Promise<ExportFile> {
  const tables: Record<string, unknown[]> = {};
  for (const t of [...WIPED_TABLES, ...EXTRA_EXPORT_TABLES]) tables[t] = (await tx.unsafe(`SELECT to_jsonb(x) AS r FROM ${t} x ORDER BY ctid`)).map((r) => r.r);
  const att: ExportFile["attachments"] = []; let total = 0;
  for (const a of (await tx`SELECT storage_name, company_id, sha256 FROM attachments`) as unknown as { storage_name: string; company_id: string; sha256: string }[]) {
    const buf = await readFile(join(uploadDir(), a.company_id, a.storage_name)).catch(() => null);
    if (!buf) throw conflict("ATTACHMENT_FILE_MISSING", `ملف المرفق ${a.storage_name} غير موجود على الخادم؛ لا يمكن إنشاء نسخة كاملة`);
    total += buf.length; if (total > MAX_EXPORT_BYTES()) throw conflict("EXPORT_TOO_LARGE", "حجم المرفقات يتجاوز حد النسخة داخل النظام؛ خذ نسخة تشغيلية (ops/backup.sh) قبل التصفير");
    att.push({ storageName: a.storage_name, companyId: a.company_id, sha256: a.sha256, dataBase64: buf.toString("base64") });
  }
  return { kind: "full-export", version: 2, createdAt: new Date().toISOString(), companyId, tables, attachments: att };
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Step 1: write a verified copy to the server's disk and remember it in the audit log. Nothing is deleted yet. */
export async function prepareReset(tx: Tx, a: Actor) {
  const exp = await buildExport(tx, a.companyId);
  const body = Buffer.from(JSON.stringify(exp));
  await mkdir(exportDir(), { recursive: true });
  const name = `pre-reset-${exp.createdAt.replace(/[:.]/g, "-")}.json`, file = join(exportDir(), name);
  await writeFile(file, body);
  const back = await readFile(file);                                                   // read it back: the copy only counts if it is intact
  if (back.length !== body.length || sha256(back) !== sha256(body)) throw new AppError(500, "EXPORT_VERIFY_FAILED", "فشل التحقق من ملف النسخة؛ لم يُحذف شيء");
  const rows = Object.fromEntries(Object.entries(exp.tables).map(([k, v]) => [k, v.length]));
  await audit(tx, a, { action: "DATA_RESET_PREPARED", entityType: "company", entityId: a.companyId, after: { file: name, sha256: sha256(body), bytes: body.length, attachments: exp.attachments.length, rows } });
  const [au] = await tx`SELECT max(id)::text AS id FROM audit_logs`;
  return { file: name, sha256: sha256(body), bytes: body.length, attachments: exp.attachments.length, rows, auditId: au!.id as string };
}

export async function resetStatus(tx: Tx) {
  const [last] = await tx`SELECT id::text AS id, occurred_at AS "at", after_data AS meta FROM audit_logs WHERE action = 'DATA_RESET_PREPARED' ORDER BY id DESC LIMIT 1`;
  return { enabled: !!process.env.RESET_DATABASE_URL, lastPrepared: last ? { at: last.at, ...(last.meta as object) } : null };
}

export async function readPrepared(name: string) {
  if (!/^pre-reset-[0-9TZ-]+\.json$/.test(name)) throw badRequest("BAD_FILE");
  return readFile(join(exportDir(), name));
}

/** Step 2: wipe. Refused unless (a) the privileged reset connection is configured, (b) the confirmation phrase matches, (c) a verified copy made in the last hour still matches the books (no audited action since). */
export async function resetData(tx: Tx, a: Actor, phrase: string) {
  const url = process.env.RESET_DATABASE_URL;
  if (!url) throw new AppError(503, "RESET_NOT_ENABLED", "التصفير غير مفعّل على هذا الخادم (يتطلب RESET_DATABASE_URL — راجع docs/RUNBOOK.md)");
  if (phrase.trim() !== RESET_PHRASE) throw badRequest("BAD_PHRASE", `اكتب عبارة التأكيد حرفياً: «${RESET_PHRASE}»`);
  const [prep] = await tx`SELECT id::text AS id, occurred_at AS "at", after_data AS meta FROM audit_logs WHERE action = 'DATA_RESET_PREPARED' ORDER BY id DESC LIMIT 1`;
  if (!prep) throw conflict("NO_BACKUP", "أنشئ النسخة الكاملة أولاً");
  if (Date.now() - new Date(prep.at as string).getTime() > MAX_PREPARED_AGE_MS()) throw conflict("BACKUP_TOO_OLD", "النسخة أقدم من المسموح؛ أنشئ نسخة جديدة");
  const [cur] = await tx`SELECT max(id)::text AS id FROM audit_logs`;
  if (cur!.id !== prep.id) throw conflict("DATA_CHANGED_SINCE_BACKUP", "حدثت عمليات بعد إنشاء النسخة؛ أنشئ نسخة جديدة ثم أعد المحاولة");
  const meta = prep.meta as { file: string; sha256: string };
  const body = await readPrepared(meta.file).catch(() => null);
  if (!body || sha256(body) !== meta.sha256) throw conflict("BACKUP_FILE_INVALID", "ملف النسخة مفقود أو تالف؛ أنشئ نسخة جديدة");
  const files = (await tx`SELECT storage_name FROM attachments WHERE entity_type NOT IN ('company_logo','company_signature')`).map((r) => r.storage_name as string);
  const priv = postgres(url, { max: 1, onnotice: () => {} });                          // a separate login that can only call the reset function; the app role cannot
  try { await priv`SELECT reset_company_data(${a.companyId}, ${a.userId}, ${priv.json({ backup: meta, attachments: files.length } as never)})`; }
  finally { await priv.end({ timeout: 5 }); }
  return { files, backup: meta.file };
}

/** Best-effort removal of uploaded files after the DB reset committed (the verified export holds copies). */
export async function removeFiles(companyId: string, names: string[]) {
  let removed = 0;
  const dir = join(uploadDir(), companyId);
  const known = new Set(await readdir(dir).catch(() => [] as string[]));
  for (const n of names) if (known.has(n)) await unlink(join(dir, n)).then(() => removed++).catch(() => {});
  return removed;
}
export const exportSize = async (name: string) => (await stat(join(exportDir(), name))).size;
