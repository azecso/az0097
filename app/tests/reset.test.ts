import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("10000000"); P = await w.mkProduct("RS"); await w.buy({ product: P, qty: "10", price: "500", date: "2026-02-01" }); await w.sale({ product: P, qty: "2", price: "900", date: "2026-02-02", type: "CREDIT" }); });
afterAll(async () => { await w.env.teardown(); });
const PH = "تصفير كل البيانات";
const post = (s: any, body: unknown) => w.api(s, w.R.reset.POST, { method: "POST", body });
const count = async (t: string) => (await w.env.admin.unsafe(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n as number;

describe("owner data reset", () => {
  it("is owner only; needs the phrase and the backup confirmation", async () => {
    expect((await post(w.acct, { phrase: PH, backedUp: true })).status).toBe(403);
    expect((await post(w.owner, { phrase: "x", backedUp: true })).body.error.code).toBe("BAD_PHRASE");
    expect((await post(w.owner, { phrase: PH })).status).toBe(400);
    expect(await count("journal_entries")).toBeGreaterThan(0);
  });
  it("the snapshot downloads first", async () => {
    const r = await w.api(w.owner, w.R.reset.GET);
    expect(r.status).toBe(200); expect(r.body.tables.sales_invoices.length).toBeGreaterThan(0);
  });
  it("wipes entries and parties, keeps settings, restarts numbering, ledger stays balanced", async () => {
    const r = await post(w.owner, { phrase: PH, backedUp: true }); expect(r.status).toBe(200);
    for (const t of ["journal_entries", "journal_lines", "sales_invoices", "purchase_orders", "contacts", "products", "stock_lots", "stock_movements", "cash_movements", "capital_transactions"]) expect(await count(t)).toBe(0);
    for (const t of ["users", "accounts", "cash_accounts", "partners", "expense_categories"]) expect(await count(t)).toBeGreaterThan(0);
    expect((await w.env.admin`SELECT max(last_number)::int AS m FROM document_sequences`)[0]!.m).toBe(0);
    expect((await w.env.admin`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'DATA_RESET'`)[0]!.n).toBe(1);
    expect((await w.tb()).balanced).toBe(true);
    const mk = async (kind: string, code: string) => (await w.api(w.owner, w.R.contacts.POST, { method: "POST", body: { kind, code, name: code } })).body.id as string;
    const sup = await mk("SUPPLIER", "S9"), cus = await mk("CUSTOMER", "C9");
    await w.fund("1000"); const p2 = await w.mkProduct("RS2");
    const po = await w.api(w.owner, w.R.purchases.POST, { method: "POST", body: { supplierId: sup, docDate: "2026-03-01", paymentType: "CASH", cashAccountId: w.ids.cashIQD, currency: "IQD", lines: [{ productId: p2, uom: "قطعة", qty: "1", unitPrice: "10" }] } });
    expect((await w.api(w.owner, w.R.purchasePost, { method: "POST", params: { id: po.body.id } })).status).toBe(200);
    const inv = await w.sale({ product: p2, qty: "1", price: "20", date: "2026-03-02", type: "CREDIT", customer: cus });
    expect(inv.body).toMatchObject({}); expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    expect((await w.getInvoice(inv.id)).docNo).toMatch(/-0*1$/);
  });
});
