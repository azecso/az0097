import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { makeWorld, type World } from "./world";

/**
 * Reference dataset with results computed BY HAND (see the comments), independent of the report code:
 *  - IQD capital 50,000,000; USD capital 10,000 @1,480 = 14,800,000 IQD
 *  - purchases: A 100 x 1,000 IQD cash; B 50 x 4 USD @1,480 (unit cost 5,920 IQD)
 *  - TWO customers named "علي": c1 (IQD) and c2 (USD)
 *  - sale 1 (c1, IQD, 2026-02-01): A 10 x 2,000 + B 5 x 9,000 = 65,000, discount 1,000 => net 64,000; COGS 10,000 + 29,600 = 39,600
 *      collected 10,000 on 02-10 and 54,000 on 03-05
 *  - sale 2 (c2, USD @1,500, 02-15): B 10 x 10 USD = 100 USD = 150,000 IQD; COGS 59,200; collected 100 USD @1,520 on 02-20 => FX gain 2,000
 *  - return (c1, 03-10): 2 of A after full payment => 3,938 IQD value (discount share of the A line = 308 => line net 19,692 => 2/10), cost 2,000, becomes customer credit
 *  - expense 30,000 accrued 02-28, paid 03-15
 */
let w: World; let A: string, B: string, c1: string, c2: string;
beforeAll(async () => {
  w = await makeWorld(); await w.fund("50000000");
  const r = await w.api(w.acct, w.R.capital.POST, { method: "POST", body: { kind: "INJECTION", docDate: "2026-01-01", cashAccountId: w.ids.cashUSD, currency: "USD", exchangeRate: "1480", amount: "10000", reason: "usd" } });
  await w.api(w.owner, w.R.capitalApprove, { method: "POST", params: { id: r.body.id }, body: {} });
  A = await w.mkProduct("RA"); B = await w.mkProduct("RB");
  await w.buy({ product: A, qty: "100", price: "1000", date: "2026-01-10" });
  await w.buy({ product: B, qty: "50", price: "4", date: "2026-01-10", currency: "USD", rate: "1480" } as any);
  const mk = async (code: string) => (await w.api(w.owner, w.R.contacts.POST, { method: "POST", body: { kind: "CUSTOMER", code, name: "علي" } })).body.id as string;
  c1 = await mk("A1"); c2 = await mk("A2");
  const inv = await w.api(w.owner, w.R.invoices.POST, { method: "POST", body: { customerId: c1, docDate: "2026-02-01", saleType: "CREDIT", currency: "IQD", discount: "1000", lines: [{ productId: A, uom: "قطعة", qty: "10", unitPrice: "2000" }, { productId: B, uom: "قطعة", qty: "5", unitPrice: "9000" }] } });
  expect((await w.api(w.owner, w.R.invoicePost, { method: "POST", params: { id: inv.body.id } })).status).toBe(200);
  const rc = async (cus: string, inv: string, date: string, cash: string, cur: string, amount: string, rate?: string) => { const x = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: cus, docDate: date, cashAccountId: cash, currency: cur, exchangeRate: rate, amount, allocations: [{ invoiceId: inv, amount }] } }); expect((await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: x.body.id } })).status).toBe(200); };
  await rc(c1, inv.body.id, "2026-02-10", w.ids.cashIQD, "IQD", "10000"); await rc(c1, inv.body.id, "2026-03-05", w.ids.cashIQD, "IQD", "54000");
  const s2 = (await w.sale({ product: B, qty: "10", price: "10", date: "2026-02-15", currency: "USD", rate: "1500", customer: c2 })).id; await rc(c2, s2, "2026-02-20", w.ids.cashUSD, "USD", "100", "1520");
  const g = await w.getInvoice(inv.body.id);
  const rd = await w.api(w.owner, w.R.sreturns.POST, { method: "POST", body: { invoiceId: inv.body.id, docDate: "2026-03-10", reason: "مرتجع مرجعي", settlement: "REDUCE_RECEIVABLE", lines: [{ salesLineId: g.lines.find((l: any) => l.productId === A).id, qtyBase: "2" }] } });
  expect((await w.api(w.owner, w.R.sreturnPost, { method: "POST", params: { id: rd.body.id } })).status).toBe(200);
  const e = await w.api(w.owner, w.R.expenses.POST, { method: "POST", body: { docDate: "2026-02-28", currency: "IQD", description: "إيجار", categoryId: await w.cat("إيجارات"), amount: "30000", paymentMode: "ACCRUED" } });
  await w.api(w.owner, w.R.expensePost, { method: "POST", params: { id: e.body.id } });
  await w.api(w.owner, w.R.expensePay.POST, { method: "POST", body: { expenseId: e.body.id, docDate: "2026-03-15", cashAccountId: w.ids.cashIQD, amount: "30000" } });
});
afterAll(async () => { await w.env.teardown(); });
const rep = async (id: string, q = "") => { const x = await w.api(w.owner, w.R.report2, { params: { id }, path: `/api/reports2/${id}${q}` } as any); if (x.status !== 200) console.log("REPFAIL", id, JSON.stringify(x.body)); return x.body; };
const N = (o: any) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v]));
const val = (r: any, label: string, key = "amount") => Number(r.rows.find((x: any) => x.label === label)?.[key]);

describe("reference dataset: every report matches the hand-computed figures", () => {
  it("profit & loss (Feb-Mar): sales 215,000, discount 1,000, returns 3,938, COGS 96,800, expenses 30,000, FX +2,000 => net 85,262", async () => {
    const r = await rep("profit-loss", "?from=2026-02-01&to=2026-03-31");
    expect(val(r, "المبيعات (الإيراد المعترف به قبل الخصم)")).toBe(215000); expect(val(r, "− الخصومات")).toBe(-1000); expect(val(r, "− المرتجعات")).toBe(-3938);
    expect(val(r, "= صافي المبيعات")).toBe(210062); expect(val(r, "− تكلفة البضاعة المسلَّمة")).toBe(-96800); expect(val(r, "= الربح التجاري (الإجمالي)")).toBe(113262);
    expect(val(r, "± فروق الصرف المحققة (ربح +/خسارة −)")).toBe(2000); expect(val(r, "= صافي نتيجة النشاط")).toBe(85262);
  });
  it("trial balance as of 28 Feb excludes March movements and stays balanced", async () => {
    const feb = await rep("trial-balance", "?asOf=2026-02-28"), mar = await rep("trial-balance", "?asOf=2026-03-31");
    expect(feb.notes[0]).toContain("متوازن"); expect(mar.notes[0]).toContain("متوازن");
    const ar = (r: any) => Number(r.rows.find((x: any) => x.code === "1200")?.balance ?? 0);
    expect(ar(feb)).toBe(64000 - 10000 + 150000 - 150000);                                     // c1 owed 54,000 on 28 Feb (the 100 USD was collected on 20 Feb)
    expect(ar(mar)).toBe(0);
  });
  it("balance sheet as of 31 Mar: assets = liabilities + equity (64,889,200)", async () => {
    const r = await rep("balance-sheet", "?asOf=2026-03-31");
    expect(val(r, "إجمالي الأصول")).toBe(64889200); expect(val(r, "نتيجة النشاط التراكمية حتى التاريخ")).toBe(85262); expect(val(r, "إجمالي حقوق الملكية")).toBe(64885262); expect(val(r, "إجمالي الالتزامات")).toBe(3938);
    expect(r.notes[0]).toContain("✔");
  });
  it("customer statements: two customers named 'علي' stay separate, one row per currency, actual cash only, credit from the return shown apart", async () => {
    const r = await rep("customers", "?to=2026-03-31"); expect(r.rows).toHaveLength(2);
    const iqd = r.rows.find((x: any) => x.currency === "IQD"), usd = r.rows.find((x: any) => x.currency === "USD");
    expect(iqd.partyId).not.toBe(usd.partyId);
    expect(N(iqd)).toMatchObject({ invoices: 64000, cash: 64000, returns: 0, closing: 0, creditReturns: 3938, creditAdvance: 0, creditClosing: 3938 });
    expect(N(usd)).toMatchObject({ invoices: 100, cash: 100, closing: 0 });
    expect(r.totals.map((t: any) => [t.currency, t.invoices]).sort()).toEqual([["IQD", "64000"], ["USD", "100"]]);       // never 64,100
    const before = await rep("customers", `?to=2026-02-28&partyId=${c1}`); expect(N(before.rows[0])).toMatchObject({ invoices: 64000, cash: 10000, closing: 54000 });   // as of 28 Feb
    const period = await rep("customers", `?from=2026-03-01&to=2026-03-31&partyId=${c1}`); expect(N(period.rows[0])).toMatchObject({ opening: 54000, invoices: 0, cash: 54000, closing: 0 });
  });
  it("inventory movement: A 100 in, 10 out, 2 returned => 92 (92,000); B 50 in, 15 out => 35 (207,200); total equals ledger 1300", async () => {
    const r = await rep("inventory-movement", "?from=2026-01-01&to=2026-03-31");
    const a = r.rows.find((x: any) => x.product.startsWith("RA")), b = r.rows.find((x: any) => x.product.startsWith("RB"));
    expect(N(a)).toMatchObject({ inq: 100, outq: 10, srq: 2, cq: 92, cv: 92000 }); expect(N(b)).toMatchObject({ inq: 50, outq: 15, cq: 35, cv: 207200 });
    expect(Number(r.totals[0].cv)).toBe(299200); expect(r.notes[0]).toContain("✔");
    const mar = await rep("inventory-movement", "?from=2026-03-01&to=2026-03-31"); expect(N(mar.rows.find((x: any) => x.product.startsWith("RA")))).toMatchObject({ oq: 90, srq: 2, cq: 92 });
  });
  it("cash movement: IQD main and USD main each in their own currency", async () => {
    const r = await rep("cash-movement", "?from=2026-01-01&to=2026-03-31");
    const closing = (acct: string) => r.rows.find((x: any) => x.account === acct && x.type === "رصيد ختامي")?.balance;
    expect(closing("الصندوق الرئيسي IQD")).toBe("49934000"); expect(closing("الصندوق الرئيسي USD")).toBe("9900");
  });
  it("ledger of 1200 opens documents and its running balance ends at the trial-balance figure", async () => {
    const r = await rep("ledger", "?account=1200&from=2026-01-01&to=2026-03-31"); expect(Number(r.rows.at(-1).balance)).toBe(0); expect(r.rows.some((x: any) => x.link?.startsWith("/sales/"))).toBe(true);
  });
  it("Excel = screen: totals per currency (never 64,100) and USD keeps two decimals", async () => {
    const res: any = await w.api(w.owner, w.R.exportReport, { params: { id: "customers" }, path: "/api/export-report/customers?to=2026-03-31" } as any);
    const buf: Buffer = res.buffer; expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as any); const ws = wb.worksheets[0]!;
    const rows: any[][] = []; ws.eachRow((row) => rows.push(row.values as any[]));
    const flat = rows.map((r) => r.join("|")); expect(flat.some((x) => x.includes("الإجمالي IQD") && x.includes("64000"))).toBe(true); expect(flat.some((x) => x.includes("الإجمالي USD") && x.includes("100"))).toBe(true);
    expect(flat.some((x) => x.includes("64100"))).toBe(false);
  });
  it("sales report: gross before discount, discount, returns, recognised revenue, cost, profit and margin; distinct invoice count under any grouping", async () => {
    const q = (g: string) => w.api(w.owner, (w.R as any).salesReport, { path: `/api/reports/sales?group=${g}&from=2026-02-01&to=2026-03-31` } as any);
    for (const g of ["invoice", "party", "product", "month"]) {
      const r = (await q(g)).body; expect(r.totals.docs, g).toBe(2);
      expect(N(r.totals)).toMatchObject({ gross: 215000, discount: 1000, returns: 3938, net: 210062, recognized: 210062, cost: 96800, profit: 113262 }); expect(Number(r.totals.margin)).toBeCloseTo(53.92, 2);
    }
    const byProduct = (await q("product")).body; expect(byProduct.rows.reduce((a: number, x: any) => a + x.docs, 0)).toBe(3);           // invoice 1 holds two products: per-row counts add up to 3, the TOTAL stays 2
  });
  it("an undelivered invoice adds to invoiced value but NOT to recognised revenue, cost or profit (no inflated profit)", async () => {
    await w.sale({ product: B, qty: "5", price: "9000", date: "2026-03-20", mode: "SEPARATE", customer: c1 });
    const r = (await w.api(w.owner, (w.R as any).salesReport, { path: "/api/reports/sales?group=invoice&from=2026-02-01&to=2026-03-31" } as any)).body;
    expect(N(r.totals)).toMatchObject({ gross: 260000, net: 255062, recognized: 210062, cost: 96800, profit: 113262 }); expect(r.totals.docs).toBe(3);
  });
  it("profit statement keeps accounting profit, eligible profit and payable liquidity apart", async () => {
    const r = await rep("profit-statement"); const get = (l: string) => Number(r.rows.find((x: any) => x.label === l)?.amount);
    expect(get("صافي نتيجة النشاط (بعد المصاريف)")).toBe(85262);
    expect(get("ربح مؤهل جديد (فواتير مسدَّدة ومسلَّمة بالكامل)")).toBeGreaterThan(0); expect(get("ربح غير مؤهل بعد (لم تُسدَّد أو تُسلَّم بالكامل)")).toBeGreaterThanOrEqual(0);
    expect(r.rows.some((x: any) => /— معتمد$/.test(x.label))).toBe(true); expect(r.notes.join(" ")).toContain("ثلاثة مقاييس");
  });
});
