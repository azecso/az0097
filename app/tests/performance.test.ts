import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, capital, type World } from "./world";
import { writeFileSync } from "node:fs";

let w: World; const timings: Record<string, number> = {};
const time = async <T>(name: string, fn: () => Promise<T>): Promise<T> => { const t = performance.now(); const r = await fn(); timings[name] = Math.round(performance.now() - t); return r; };
beforeAll(async () => { w = await makeWorld(); await capital(w, "900000000"); }, 300_000);
afterAll(async () => { console.log("PERF_RESULTS " + JSON.stringify(timings)); try { writeFileSync("/tmp/claude-0/perf.json", JSON.stringify(timings, null, 2)); } catch { /* ignore */ } await w.env.teardown(); });

describe("performance on a realistic data volume", () => {
  it("loads ~120,000 journal lines + 20 products with 100 FIFO layers each, then everything stays fast", async () => {
    const prods: string[] = []; for (let i = 0; i < 20; i++) prods.push(await w.mkProduct("PF" + i));
    await time("seed: 100 purchase invoices (20 products x 5 layers) via the API", async () => { for (let k = 0; k < 5; k++) for (const p of prods) { const r = await w.buy({ product: p, qty: "1000", price: String(1000 + k * 10), date: `2026-0${1 + k}-10`, type: "CREDIT" }); expect(r.status).toBe(200); } });
    // bulk ledger history (balanced entries) so reports run over six figures of lines
    await time("seed: 60,000 balanced entries (120,000 lines) via SQL", async () => {
      await w.env.admin`
        WITH a AS (SELECT (SELECT id FROM accounts WHERE code = '6900') ex, (SELECT id FROM accounts WHERE code = '1110') cash),
        e AS (INSERT INTO journal_entries(company_id, entry_no, entry_date, source_doc_type, source_doc_id, posted_by)
              SELECT ${w.env.companyId}, 'BULK-' || g, date '2025-11-01' + (g % 400), 'bulk', gen_random_uuid(), ${w.env.ownerId} FROM generate_series(1, 60000) g RETURNING id, entry_no)
        INSERT INTO journal_lines(company_id, entry_id, line_no, account_id, debit_base, credit_base, currency, amount_orig, fx_rate_snapshot)
        SELECT ${w.env.companyId}, e.id, n, CASE n WHEN 1 THEN a.ex ELSE a.cash END, CASE n WHEN 1 THEN 1000 ELSE 0 END, CASE n WHEN 2 THEN 1000 ELSE 0 END, 'IQD', 1000, 1 FROM e, a, generate_series(1, 2) n`;
    });
    const jl = (await w.env.admin`SELECT count(*)::int n FROM journal_lines`)[0]!.n; expect(jl).toBeGreaterThan(120000);

    const dash = (await import("@/app/api/dashboard/route")).GET;
    const d = await time("dashboard (12-month series, top lists, equation check, settlement preview)", () => w.api(w.owner, dash)); expect(d.status).toBe(200); expect(d.body.integrity.balanced).toBe(true);
    await time("trial balance over 120k lines", () => w.api(w.owner, w.R.trial)); await time("inventory reconciliation", () => w.recon());
    await time("stock summary (100 layers)", () => w.api(w.owner, w.R.stock));
    const ex = await import("@/app/api/export/[kind]/route");
    await time("Excel: trial balance", () => ex.GET(new (require("next/server").NextRequest)("http://localhost:3000/api/export/trial-balance", { headers: { host: "localhost:3000", cookie: w.owner.cookie } }), { params: Promise.resolve({ kind: "trial-balance" }) }));
  }, 600_000);

  it("posts a 50-line invoice (FIFO over many layers) and 20 sequential invoices within budget", async () => {
    const prods = (await w.api(w.owner, w.R.products.GET)).body.slice(0, 20).map((p: any) => p.id);
    const lines = Array.from({ length: 50 }, (_, i) => ({ productId: prods[i % 20], uom: "قطعة", qty: "3", unitPrice: "5000" }));
    const c = await w.api(w.owner, w.R.invoices.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-07-01", saleType: "CREDIT", currency: "IQD", lines } });
    const r = await time("post one 50-line invoice (FIFO + COGS + journal)", () => w.api(w.owner, w.R.invoicePost, { method: "POST", params: { id: c.body.id } })); expect(r.status).toBe(200);
    await time("20 sequential single-line invoices (create + post)", async () => { for (let i = 0; i < 20; i++) { const x = await w.sale({ product: prods[i], qty: "2", price: "6000" }); expect(x.status).toBe(200); } });
    const par = await time("10 simultaneous invoice postings on different products", async () => {
      const ids = []; for (let i = 0; i < 10; i++) ids.push((await w.sale({ product: prods[i], qty: "1", price: "7000", noPost: true })).body.id);
      return Promise.all(ids.map((id: string) => w.api(w.owner, w.R.invoicePost, { method: "POST", params: { id } }))); });
    expect(par.every((x: any) => x.status === 200)).toBe(true);
    expect((await w.recon()).ok).toBe(true); expect((await w.tb()).balanced).toBe(true);
  }, 300_000);

  it("stays within the budgets", () => {
    const t = timings;
    expect(t["dashboard (12-month series, top lists, equation check, settlement preview)"]).toBeLessThan(3000);
    expect(t["trial balance over 120k lines"]).toBeLessThan(2500);
    expect(t["post one 50-line invoice (FIFO + COGS + journal)"]).toBeLessThan(1500);
    expect(t["20 sequential single-line invoices (create + post)"]).toBeLessThan(10000);
  });
});
