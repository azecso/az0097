import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { migrate } from "../scripts/migrate";
import { bootstrapCompany } from "../scripts/bootstrap";

const ADMIN = process.env.TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
const dbName = "erp_up_" + randomBytes(4).toString("hex");
let admin: postgres.Sql;
afterAll(async () => { await admin?.end(); const b = postgres(ADMIN, { max: 1 }); await b.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await b.end(); });

describe("upgrading a database that already holds data (migrations 0013-0018)", () => {
  it("keeps every row, defaults new columns safely, adds the new accounts, and the impact report finds the legacy shapes", async () => {
    const base = postgres(ADMIN, { max: 1, onnotice: () => {} }); await base.unsafe(`CREATE DATABASE ${dbName}`); await base.end();
    const u = new URL(ADMIN); u.pathname = "/" + dbName; const url = u.toString();
    await migrate(url, undefined, undefined, "0012_amend_receipts.sql");                       // the schema as it was before this review
    admin = postgres(url, { max: 2, onnotice: () => {} });
    const { companyId, ownerId } = await bootstrapCompany(admin, { companyName: "قديمة", ownerUsername: "owner", ownerPassword: "Owner-Pass-2026-x1" });
    await admin`DELETE FROM cash_accounts WHERE account_id IN (SELECT id FROM accounts WHERE code = '1151')`; await admin`DELETE FROM accounts WHERE code IN ('1151','2600')`;   // legacy chart had neither
    // legacy shape 1: a USD cash opening booked 1:1 (100 USD = 100 IQD)
    const acc = async (c: string) => (await admin`SELECT id FROM accounts WHERE code = ${c}`)[0]!.id as string;
    const je = (await admin`INSERT INTO journal_entries(company_id, entry_no, entry_date, source_doc_type, source_doc_id, posted_by, memo) VALUES (${companyId}, 'JE-2025-000001', '2025-12-31', 'opening', gen_random_uuid(), ${ownerId}, 'legacy opening') RETURNING id`)[0]!.id;
    await admin`INSERT INTO journal_lines(company_id, entry_id, line_no, account_id, debit_base, credit_base, currency, amount_orig, fx_rate_snapshot) VALUES (${companyId}, ${je}, 1, ${await acc("1120")}, 100, 0, 'USD', 100, 1), (${companyId}, ${je}, 2, ${await acc("3100")}, 0, 100, 'IQD', 100, 1)`;
    // legacy shape 2: a USD accrued expense paid with no payment rate
    const cat = (await admin`SELECT id FROM expense_categories LIMIT 1`)[0]!.id; const cash = (await admin`SELECT id FROM cash_accounts WHERE currency = 'USD' LIMIT 1`)[0]!.id;
    const ex = (await admin`INSERT INTO expenses(company_id, draft_ref, doc_no, doc_date, category_id, description, currency, exchange_rate_snapshot, amount, amount_base, payment_mode, status, created_by) VALUES (${companyId}, 'D1', 'EX-2025-000001', '2025-12-01', ${cat}, 'إيجار', 'USD', 1480, 100, 148000, 'ACCRUED', 'POSTED', ${ownerId}) RETURNING id`)[0]!.id;
    await admin`INSERT INTO expense_payments(company_id, draft_ref, doc_no, doc_date, expense_id, cash_account_id, amount, amount_base, status, created_by) VALUES (${companyId}, 'D2', 'EP-2025-000001', '2025-12-20', ${ex}, ${cash}, 100, 148000, 'POSTED', ${ownerId})`;
    const before = { je: (await admin`SELECT count(*)::int n FROM journal_entries`)[0]!.n, lines: (await admin`SELECT count(*)::int n FROM journal_lines`)[0]!.n, exp: (await admin`SELECT count(*)::int n FROM expenses`)[0]!.n, audit: (await admin`SELECT count(*)::int n FROM audit_logs`)[0]!.n };
    await migrate(url, { user: "erp_up_app", password: "x-up-pw-1" });                         // the upgrade
    const after = { je: (await admin`SELECT count(*)::int n FROM journal_entries`)[0]!.n, lines: (await admin`SELECT count(*)::int n FROM journal_lines`)[0]!.n, exp: (await admin`SELECT count(*)::int n FROM expenses`)[0]!.n, audit: (await admin`SELECT count(*)::int n FROM audit_logs`)[0]!.n };
    expect(after).toEqual(before);                                                             // nothing deleted, nothing rewritten
    expect((await admin`SELECT count(*)::int n FROM accounts WHERE code IN ('1151','2600')`)[0]!.n).toBe(2);
    expect((await admin`SELECT count(*)::int n FROM cash_accounts ca JOIN accounts a ON a.id = ca.account_id WHERE a.code = '1151' AND ca.currency = 'USD' AND NOT ca.counts_toward_available_cash`)[0]!.n).toBe(1);
    const p = (await admin`SELECT exchange_rate_snapshot, fx_diff_base::text d FROM expense_payments`)[0]!; expect(p.exchange_rate_snapshot).toBeNull(); expect(p.d).toBe("0.0000");      // legacy: no payment rate, no FX booked
    expect((await admin`SELECT bool_or(revenue_deferred) v FROM sales_invoices`)[0]!.v).toBeNull();
    const out = await admin.unsafe(readFileSync("../ops/data-impact.sql", "utf8").split("\n").filter((l) => !l.startsWith("\\echo")).join("\n"));
    expect(Array.isArray(out)).toBe(true);
    const q1 = await admin`SELECT je.entry_no FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.source_doc_type = 'opening' AND jl.currency = 'USD' AND jl.fx_rate_snapshot = 1 AND jl.debit_base > 0`; expect(q1).toHaveLength(1);
    const q2 = await admin`SELECT p.doc_no FROM expense_payments p JOIN expenses e ON e.id = p.expense_id WHERE e.currency <> 'IQD' AND p.exchange_rate_snapshot IS NULL AND p.status = 'POSTED'`; expect(q2).toHaveLength(1);
    expect((await admin`SELECT 1 FROM pg_roles WHERE rolname = 'erp_up_app'`)).toHaveLength(1);
    const lock = await admin`SELECT has_function_privilege('erp_up_app', 'reset_company_data(uuid, uuid, jsonb)', 'EXECUTE') AS can`; expect(lock[0]!.can).toBe(false);
    await admin`DROP OWNED BY erp_up_app`; await admin`DROP ROLE erp_up_app`;
  });
});
