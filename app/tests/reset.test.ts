import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWorld, type World } from "./world";
import { restoreExport } from "../scripts/restore-export";

let w: World; let P: string; let dir: string; let tbBefore: any; let invoiceNo: string;
beforeAll(async () => {
  w = await makeWorld(); dir = await mkdtemp(join(tmpdir(), "erp-reset-")); process.env.UPLOAD_DIR = join(dir, "uploads"); process.env.EXPORT_DIR = join(dir, "exports"); delete process.env.RESET_DATABASE_URL;
  await w.fund("10000000"); P = await w.mkProduct("RS"); await w.buy({ product: P, qty: "10", price: "500", date: "2026-02-01" });
  const s = await w.sale({ product: P, qty: "2", price: "900", date: "2026-02-02", type: "CREDIT" }); invoiceNo = (await w.getInvoice(s.id)).docNo;
  await mkdir(join(dir, "uploads", w.env.companyId), { recursive: true }); await writeFile(join(dir, "uploads", w.env.companyId, "doc1.png"), Buffer.from("89504e470d0a1a0a00", "hex"));
  await w.env.admin`INSERT INTO attachments(company_id, entity_type, entity_id, storage_name, original_name, sha256, mime_type, size_bytes, uploaded_by) VALUES (${w.env.companyId}, 'sales_invoice', ${s.id}, 'doc1.png', 'doc1.png', ${"0".repeat(64)}, 'image/png', 9, ${w.env.ownerId})`;
  tbBefore = await w.tb();
});
afterAll(async () => { delete process.env.RESET_DATABASE_URL; await w.env.teardown(); });
const PH = "تصفير كل البيانات";
const api = (s: any, body: unknown) => w.api(s, w.R.reset.POST, { method: "POST", body });
const count = async (t: string) => (await w.env.admin.unsafe(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n as number;
const exists = (p: string) => access(p).then(() => true, () => false);

describe("owner data reset: isolated, backed up first, restorable", () => {
  it("is disabled until a separate reset connection is configured; owner only", async () => {
    expect((await api(w.owner, { action: "prepare" })).status).toBe(200);
    expect((await api(w.owner, { action: "reset", phrase: PH })).body.error.code).toBe("RESET_NOT_ENABLED");
    expect((await api(w.acct, { action: "reset", phrase: PH })).status).toBe(403);
    expect((await w.api(w.owner, w.R.reset.GET)).body.enabled).toBe(false);
    process.env.RESET_DATABASE_URL = w.env.adminDbUrl;                                    // stands for the dedicated reset login
  });
  it("the application role cannot call the reset function at all", async () => {
    await expect(w.inject((tx: any) => tx`SELECT reset_company_data(${w.env.companyId}, ${w.env.ownerId}, '{}'::jsonb)`)).rejects.toThrow(/permission denied/i);
  });
  it("needs the phrase and a fresh verified copy; any audited change after the copy invalidates it", async () => {
    expect((await api(w.owner, { action: "reset", phrase: "x" })).body.error.code).toBe("BAD_PHRASE");
    const p = await api(w.owner, { action: "prepare" }); expect(p.status).toBe(200); expect(p.body.rows.journal_entries).toBeGreaterThan(0); expect(p.body.attachments).toBe(1);
    expect(await exists(join(dir, "exports", p.body.file))).toBe(true);
    await w.api(w.owner, w.R.contacts.POST, { method: "POST", body: { kind: "CUSTOMER", code: "LATE", name: "بعد النسخة" } });
    expect((await api(w.owner, { action: "reset", phrase: PH })).body.error.code).toBe("DATA_CHANGED_SINCE_BACKUP");
  });
  let backup = "";
  it("wipes entries and parties, keeps settings, restarts numbering, removes the files, records the audit entry; ledger balanced", async () => {
    backup = (await api(w.owner, { action: "prepare" })).body.file;
    const r = await api(w.owner, { action: "reset", phrase: PH }); expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const t of ["journal_entries", "journal_lines", "sales_invoices", "purchase_orders", "contacts", "products", "stock_lots", "stock_movements", "cash_movements", "capital_transactions"]) expect(await count(t)).toBe(0);
    for (const t of ["users", "accounts", "cash_accounts", "partners", "expense_categories"]) expect(await count(t)).toBeGreaterThan(0);
    expect((await w.env.admin`SELECT max(last_number)::int AS m FROM document_sequences`)[0]!.m).toBe(0);
    const a = (await w.env.admin`SELECT after_data FROM audit_logs WHERE action = 'DATA_RESET'`); expect(a).toHaveLength(1); expect(a[0]!.after_data.backup.file).toBe(backup);
    await new Promise((r) => setTimeout(r, 200)); expect(await exists(join(dir, "uploads", w.env.companyId, "doc1.png"))).toBe(false);
    expect((await w.tb()).balanced).toBe(true);
  });
  it("the verified copy restores everything: rows, numbering, ledger totals and the uploaded file", async () => {
    const out = await restoreExport(w.env.adminDbUrl, join(dir, "exports", backup), join(dir, "uploads"));
    expect(out.attachments).toBe(1);
    const tb = await w.tb(); expect(tb.balanced).toBe(true); expect(tb.totalDebit).toBe(tbBefore.totalDebit);
    expect(tb.rows.map((x: any) => [x.code, x.debit, x.credit])).toEqual(tbBefore.rows.map((x: any) => [x.code, x.debit, x.credit]));
    expect((await w.api(w.owner, w.R.invoices.GET)).body.map((x: any) => x.docNo)).toContain(invoiceNo);
    expect((await readFile(join(dir, "uploads", w.env.companyId, "doc1.png"))).length).toBe(9);
    expect((await w.recon()).ok).toBe(true);
    const s = await w.sale({ product: P, qty: "1", price: "900", date: "2026-02-05", type: "CREDIT" }); expect(s.status, JSON.stringify(s.body)).toBe(200);   // sequences and identity columns continue after the restore
    expect((await w.getInvoice(s.id)).docNo).not.toBe(invoiceNo);
  });
  it("refuses to restore over existing data", async () => {
    await expect(restoreExport(w.env.adminDbUrl, join(dir, "exports", backup), join(dir, "uploads"))).rejects.toThrow(/already holds/);
  });
});
