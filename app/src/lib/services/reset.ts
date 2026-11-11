import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Tx } from "../db";
import { audit, type Actor } from "../audit";
import { badRequest } from "../errors";

export const RESET_PHRASE = "تصفير كل البيانات";
const uploadDir = () => process.env.UPLOAD_DIR ?? join(process.cwd(), "data", "uploads");

const DUMP_TABLES = ["accounts", "cash_accounts", "expense_categories", "partners", "contacts", "products", "product_uoms", "employees",
  "purchase_orders", "purchase_lines", "purchase_charges", "supplier_payments", "supplier_payment_allocations", "purchase_returns", "purchase_return_lines",
  "sales_quotes", "sales_quote_lines", "sales_invoices", "sales_lines", "delivery_notes", "delivery_lines", "sales_returns", "sales_return_lines",
  "customer_receipts", "receipt_allocations", "cash_transfers", "cash_movements", "expenses", "expense_payments", "payroll_accruals", "payroll_payments",
  "personal_advances", "personal_debts", "capital_transactions", "capital_returns", "opening_balances", "profit_settlements", "profit_settlement_lines",
  "profit_settlement_shares", "profit_payouts", "stock_lots", "stock_movements", "stock_lot_consumptions", "stock_lot_returns", "stock_transfers",
  "stock_transfer_lines", "inventory_counts", "inventory_count_lines", "journal_entries", "journal_lines", "accounting_periods", "attachments", "document_sequences"];

/** Full JSON snapshot of everything the reset would touch — offered for download before deleting. */
export async function dumpBeforeReset(tx: Tx) {
  const out: Record<string, unknown[]> = {};
  for (const t of DUMP_TABLES) out[t] = await tx.unsafe(`SELECT to_jsonb(x) AS r FROM ${t} x`).then((rows) => rows.map((r) => r.r));
  return { kind: "pre-reset-backup", createdAt: new Date().toISOString(), tables: out };
}

export async function resetData(tx: Tx, a: Actor, phrase: string) {
  if (phrase.trim() !== RESET_PHRASE) throw badRequest("BAD_PHRASE", `اكتب عبارة التأكيد حرفياً: «${RESET_PHRASE}»`);
  const [{ n: jn }] = (await tx`SELECT count(*)::int AS n FROM journal_entries`) as unknown as [{ n: number }];
  const files = (await tx`SELECT storage_name FROM attachments WHERE entity_type NOT IN ('company_logo','company_signature')`).map((r) => r.storage_name as string);
  await tx`SELECT reset_company_data(${a.companyId})`;
  await audit(tx, a, { action: "DATA_RESET", entityType: "company", entityId: a.companyId, before: { journalEntries: jn, attachments: files.length }, reason: "تصفير البيانات المُدخلة بواسطة المالك" });
  return { files };
}

/** Best-effort removal of uploaded files after the DB reset committed. */
export async function removeFiles(companyId: string, names: string[]) {
  let removed = 0;
  const dir = join(uploadDir(), companyId);
  const known = new Set(await readdir(dir).catch(() => [] as string[]));
  for (const n of names) if (known.has(n)) await unlink(join(dir, n)).then(() => removed++).catch(() => {});
  return removed;
}
