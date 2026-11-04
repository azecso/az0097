// Applies db/migrations/*.sql in order (each in a transaction), tracks checksums, then ensures the
// least-privilege application role. Run as the DB owner:  DATABASE_URL=... npm run migrate
import postgres from "postgres";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

export async function migrate(url: string, appRole?: { user: string; password: string }) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`SELECT pg_advisory_lock(727001)`;
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    const applied = new Map((await sql`SELECT name, checksum FROM schema_migrations`).map((r) => [r.name, r.checksum]));
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      const body = readFileSync(join(dir, file), "utf8");
      const sum = createHash("sha256").update(body).digest("hex");
      if (applied.has(file)) {
        if (applied.get(file) !== sum) throw new Error(`Migration ${file} was modified after being applied`);
        continue;
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migrations(name, checksum) VALUES (${file}, ${sum})`;
      });
      console.log(`applied ${file}`);
    }
    if (appRole) {
      if (!/^[a-z_][a-z0-9_]*$/.test(appRole.user)) throw new Error("invalid app role name");
      const exists = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${appRole.user}`;
      const pw = appRole.password.replace(/'/g, "''");
      if (exists.length === 0) await sql.unsafe(`CREATE ROLE ${appRole.user} LOGIN PASSWORD '${pw}' NOSUPERUSER NOBYPASSRLS`);
      else {
        // Managed hosts (e.g. Neon) forbid non-superusers from changing SUPERUSER/BYPASSRLS attributes:
        // set only the password, then verify the role is still unprivileged.
        await sql.unsafe(`ALTER ROLE ${appRole.user} PASSWORD '${pw}'`);
        const [flags] = await sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ${appRole.user}`;
        if (flags!.rolsuper || flags!.rolbypassrls) throw new Error(`app role ${appRole.user} must not be SUPERUSER or BYPASSRLS`);
      }
      const db = (await sql`SELECT current_database() AS d`)[0]!.d as string;
      await sql.unsafe(`GRANT CONNECT ON DATABASE "${db}" TO ${appRole.user}`);
      await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${appRole.user}`);
      // DML only; no TRUNCATE/DROP/REFERENCES/TRIGGER. DELETE intentionally NOT granted on financial/audit tables.
      await sql.unsafe(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${appRole.user}`);
      // DELETE only on tables whose rows may be removed while DRAFT (guard triggers reject non-DRAFT deletes).
      const deletable = ["user_permissions", "product_uoms", "purchase_orders", "purchase_lines", "purchase_charges", "purchase_returns", "purchase_return_lines",
        "supplier_payments", "supplier_payment_allocations", "stock_transfers", "stock_transfer_lines", "inventory_counts", "inventory_count_lines",
        "sales_quotes", "sales_quote_lines", "sales_invoices", "sales_lines", "delivery_notes", "delivery_lines", "sales_returns", "sales_return_lines", "customer_receipts", "receipt_allocations", "cash_transfers",
        "expenses", "expense_payments", "personal_advances", "opening_balances", "profit_settlements", "capital_transactions", "employees", "capital_returns"];
      for (const t of deletable) await sql.unsafe(`GRANT DELETE ON ${t} TO ${appRole.user}`);
      await sql.unsafe(`REVOKE UPDATE ON schema_migrations FROM ${appRole.user}`);
      await sql.unsafe(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${appRole.user}`);
      await sql.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${appRole.user}`);
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(727001)`.catch(() => {});
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const user = process.env.APP_DB_USER, password = process.env.APP_DB_PASSWORD;
  await migrate(url, user && password ? { user, password } : undefined);
  console.log("migrations complete");
}
