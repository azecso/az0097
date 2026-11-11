// One-time setup: creates the company, the OWNER user, the default chart of accounts and numbering.
// Run as DB owner:  COMPANY_NAME=... OWNER_USERNAME=... OWNER_PASSWORD=... DATABASE_URL=... npm run bootstrap
// The password is read from the environment and never printed or stored in plain text.
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { hashPassword, assertStrongPassword } from "../src/lib/auth";

const ACCOUNTS: Array<[string, string, string, "DEBIT" | "CREDIT", boolean?]> = [
  ["1110", "الصندوق الرئيسي IQD", "ASSET", "DEBIT"], ["1120", "الصندوق الرئيسي USD", "ASSET", "DEBIT"],
  ["1130", "حساب مصرفي", "ASSET", "DEBIT"], ["1150", "عهدة نقدية — الشريك", "ASSET", "DEBIT"], ["1151", "عهدة نقدية — الشريك USD", "ASSET", "DEBIT"],
  ["1200", "ذمم العملاء", "ASSET", "DEBIT"], ["1250", "سلف الشريك", "ASSET", "DEBIT"],
  ["1300", "مخزون — الموقع الرئيسي", "ASSET", "DEBIT"], ["1310", "مخزون — بعهدة الشريك", "ASSET", "DEBIT"],
  ["1390", "مشتريات تحت التسوية", "ASSET", "DEBIT"],
  ["2100", "ذمم الموردين", "LIABILITY", "CREDIT"], ["2200", "رواتب مستحقة", "LIABILITY", "CREDIT"],
  ["2210", "مصروفات مستحقة", "LIABILITY", "CREDIT"], ["2300", "ذمة مستحقة للشريك", "LIABILITY", "CREDIT"],
  ["2400", "أرصدة دائنة للعملاء", "LIABILITY", "CREDIT"], ["2600", "إيرادات مؤجلة — فواتير غير مسلّمة", "LIABILITY", "CREDIT"], ["2500", "أرباح معتمدة مستحقة الدفع", "LIABILITY", "CREDIT"],
  ["3100", "رأس المال — المالك", "EQUITY", "CREDIT"], ["3200", "سحوبات المالك", "EQUITY", "DEBIT"],
  ["3300", "أرباح محتجزة", "EQUITY", "CREDIT"], ["3400", "أرباح موزعة", "EQUITY", "DEBIT"], ["3500", "أرباح موزَّعة خارج النظام", "EQUITY", "DEBIT"],
  ["3900", "رصيد افتتاحي مُوازِن (مؤقت)", "EQUITY", "CREDIT"],
  ["4100", "مبيعات", "REVENUE", "CREDIT"], ["4150", "خصومات مبيعات", "REVENUE", "DEBIT"], ["4190", "مرتجعات مبيعات", "REVENUE", "DEBIT"],
  ["5100", "تكلفة البضاعة المباعة", "COGS", "DEBIT"], ["5200", "فروقات الجرد", "COGS", "DEBIT"],
  ["6100", "مصروف نقل", "EXPENSE", "DEBIT"], ["6200", "رواتب وأجور", "EXPENSE", "DEBIT"], ["6900", "مصروفات عامة", "EXPENSE", "DEBIT"],
  ["7100", "أرباح/خسائر فروق الصرف", "OTHER", "CREDIT"],
];
const SEQUENCES: Array<[string, string]> = [
  ["sales_invoice", "INV"], ["sales_quote", "QT"], ["delivery_note", "DN"], ["sales_return", "SR"], ["customer_receipt", "RC"],
  ["purchase_order", "PO"], ["purchase_receipt", "GR"], ["purchase_return", "PR"], ["supplier_payment", "PV"],
  ["cash_transfer", "TR"], ["expense", "EX"], ["capital", "CP"], ["capital_return", "CR"], ["profit_settlement", "PS"], ["journal_entry", "JE"],
];

export async function bootstrapCompany(db: postgres.Sql, o: { companyName: string; ownerUsername: string; ownerDisplayName?: string; ownerPassword: string }) {
  assertStrongPassword(o.ownerPassword);
  const username = o.ownerUsername.toLowerCase();
  const pw = await hashPassword(o.ownerPassword);
  return db.begin(async (tx) => {
    const [existing] = await tx`SELECT count(*)::int AS n FROM companies`;
    if (existing!.n > 0) throw new Error("A company already exists; bootstrap is one-time only");
    const [c] = await tx`INSERT INTO companies(name) VALUES (${o.companyName}) RETURNING id`;
    const companyId = c!.id as string;
    const [u] = await tx`INSERT INTO users(company_id, username, display_name, password_hash, is_owner)
      VALUES (${companyId}, ${username}, ${o.ownerDisplayName ?? o.ownerUsername}, ${pw}, true) RETURNING id`;
    for (const [code, name, type, side] of ACCOUNTS)
      await tx`INSERT INTO accounts(company_id, code, name, type, normal_side, is_system) VALUES (${companyId}, ${code}, ${name}, ${type}, ${side}, true)`;
    const year = new Date().getUTCFullYear();
    for (const [t, prefix] of SEQUENCES)
      await tx`INSERT INTO document_sequences(company_id, doc_type, fiscal_year, prefix) VALUES (${companyId}, ${t}, ${year}, ${prefix})`;
    await tx`SELECT seed_company_operational(${companyId})`;
    await tx`SELECT seed_company_finance(${companyId})`;
    await tx`INSERT INTO audit_logs(company_id, user_id, action, entity_type, entity_id, after_data)
      VALUES (${companyId}, ${u!.id}, 'company.bootstrap', 'company', ${companyId}, ${tx.json({ owner: username })})`;
    return { companyId, ownerId: u!.id as string };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { DATABASE_URL, COMPANY_NAME, OWNER_USERNAME, OWNER_PASSWORD } = process.env;
  if (!DATABASE_URL || !COMPANY_NAME || !OWNER_USERNAME || !OWNER_PASSWORD) throw new Error("Set DATABASE_URL, COMPANY_NAME, OWNER_USERNAME, OWNER_PASSWORD");
  const db = postgres(DATABASE_URL, { max: 1 });
  try { const r = await bootstrapCompany(db, { companyName: COMPANY_NAME, ownerUsername: OWNER_USERNAME, ownerPassword: OWNER_PASSWORD }); console.log("company created:", r.companyId); }
  finally { await db.end(); }
}
