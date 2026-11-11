// Restores a pre-reset export (src/lib/services/reset.ts) into a database whose kept tables (company, users, chart, cash accounts, partners) are intact —
// i.e. the same database right after a reset, or a restored base backup. Run as the DB owner:
//   DATABASE_URL=postgres://owner@host/db UPLOAD_DIR=/data/uploads npx tsx scripts/restore-export.ts <export.json>
import postgres from "postgres";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WIPED_TABLES, type ExportFile } from "../src/lib/services/reset";

export async function restoreExport(url: string, file: string, uploadDir: string) {
  const exp = JSON.parse(await readFile(file, "utf8")) as ExportFile;
  if (exp.kind !== "full-export" || exp.version !== 2) throw new Error("unsupported export file");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const nonEmpty = (await sql.unsafe(`SELECT (SELECT count(*) FROM journal_entries) + (SELECT count(*) FROM contacts) + (SELECT count(*) FROM products) AS n`))[0]!.n;
    if (Number(nonEmpty) > 0) throw new Error("refusing to restore into a database that already holds ledger/party/product data");
    // dependency order from the real foreign keys among the restored tables
    const edges = await sql`SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent FROM pg_constraint c WHERE c.contype = 'f'`;
    const set = new Set<string>(WIPED_TABLES), deps = new Map<string, Set<string>>();
    for (const t of set) deps.set(t, new Set());
    for (const e of edges) if (set.has(e.child) && set.has(e.parent) && e.child !== e.parent) deps.get(e.child)!.add(e.parent);
    const order: string[] = []; const seen = new Set<string>();
    const visit = (t: string) => { if (seen.has(t)) return; seen.add(t); for (const p of deps.get(t)!) visit(p); order.push(t); };
    for (const t of WIPED_TABLES) visit(t);
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.company_id', ${exp.companyId}, true)`;
      for (const t of order) {
        const rows = exp.tables[t] ?? []; if (!rows.length) continue;
        await tx.unsafe(`INSERT INTO ${t} OVERRIDING SYSTEM VALUE SELECT * FROM jsonb_populate_recordset(null::${t}, $1::text::jsonb)`, [JSON.stringify(rows)]);
      }
      for (const r of exp.tables.attachments ?? []) await tx.unsafe(`INSERT INTO attachments SELECT * FROM jsonb_populate_record(null::attachments, $1::text::jsonb) ON CONFLICT (id) DO NOTHING`, [JSON.stringify(r)]);
      for (const r of (exp.tables.document_sequences ?? []) as { company_id: string; doc_type: string; fiscal_year: number; last_number: number }[])
        await tx`UPDATE document_sequences SET last_number = ${r.last_number} WHERE company_id = ${r.company_id} AND doc_type = ${r.doc_type} AND fiscal_year = ${r.fiscal_year}`;
      for (const t of order) for (const col of (await tx`SELECT a.attname AS c FROM pg_attribute a WHERE a.attrelid = ${t}::regclass AND a.attidentity <> '' AND NOT a.attisdropped`))
        await tx.unsafe(`SELECT setval(pg_get_serial_sequence('${t}', '${col.c}'), GREATEST((SELECT COALESCE(max(${col.c}), 0) FROM ${t}), 1), (SELECT count(*) > 0 FROM ${t}))`);
    });
    for (const f of exp.attachments) { const dir = join(uploadDir, f.companyId); await mkdir(dir, { recursive: true }); await writeFile(join(dir, f.storageName), Buffer.from(f.dataBase64, "base64")); }
    return { tables: order.filter((t) => (exp.tables[t] ?? []).length).length, attachments: exp.attachments.length };
  } finally { await sql.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file] = process.argv.slice(2); const url = process.env.DATABASE_URL;
  if (!file || !url) throw new Error("usage: DATABASE_URL=... npx tsx scripts/restore-export.ts <export.json>");
  console.log(await restoreExport(url, file, process.env.UPLOAD_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "data", "uploads")));
}
