import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, type World } from "./world";

let w: World; let dash: any, alertsR: any;
beforeAll(async () => { w = await makeWorld(); dash = (await import("@/app/api/dashboard/route")).GET; alertsR = (await import("@/app/api/alerts/route")).GET; await w.fund("10000000"); });
afterAll(async () => { await w.env.teardown(); });
const get = async (q = "") => (await w.api(w.owner, dash, { path: "/api/dashboard" + q } as any)).body;
const iso = (d = new Date()) => d.toISOString().slice(0, 10);

describe("dashboard shows the real ledger and always balances", () => {
  it("every figure matches a scripted scenario; the accounting equation difference is exactly zero", async () => {
    const today = iso(), P = await w.mkProduct("D1");
    await w.buy({ product: P, qty: "100", price: "7000", date: today });                                               // cash 700,000 -> inventory
    const inv = await w.sale({ product: P, qty: "100", price: "10000", date: today });                                  // revenue 1,000,000, COGS 700,000
    const rc = async (acct: string, amount: string) => { const r = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: today, cashAccountId: acct, currency: "IQD", amount, allocations: [{ invoiceId: inv.id, amount }] } }); await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: r.body.id } }); };
    await rc(w.ids.cashIQD, "400000"); await rc(w.ids.custody, "200000");                                              // 600,000 collected; 200,000 still with the partner
    const e = await w.api(w.owner, w.R.expenses.POST, { method: "POST", body: { docDate: today, currency: "IQD", description: "إيجار", categoryId: await w.cat("إيجارات"), amount: "100000", paymentMode: "PAID_CASH", cashAccountId: w.ids.cashIQD } });
    await w.api(w.owner, w.R.expensePost, { method: "POST", params: { id: e.body.id } });
    const b = await get();
    expect(b.balances.capital).toBe("10000000");
    expect(Number(b.balances.mainCash)).toBe(10000000 - 700000 + 400000 - 100000);                                      // 9,600,000
    expect(Number(b.balances.partnerCustodyCash)).toBe(200000);                                                          // shown separately, not inside cash
    expect(Number(b.balances.inventoryMain)).toBe(0); expect(Number(b.balances.receivables)).toBe(400000);
    expect(Number(b.period.revenue)).toBe(1000000); expect(Number(b.period.cogs)).toBe(700000); expect(Number(b.period.grossProfit)).toBe(300000);
    expect(Number(b.period.expenses)).toBe(100000); expect(Number(b.period.netProfit)).toBe(200000); expect(Number(b.period.collections)).toBe(600000);
    expect(b.integrity.equationDifference).toBe("0"); expect(b.integrity.balanced).toBe(true); expect(b.integrity.inventoryReconciled).toBe(true);
    // distributable now: collection-linked profit 300,000 x 600/1000 = 180,000 minus accrued expenses 100,000 = 80,000 -> 40,000 each
    expect(Number(b.distributable.eligibleProfit)).toBe(180000); expect(Number(b.distributable.deductions)).toBe(100000);
    expect(Number(b.distributable.distributable)).toBe(80000); expect(Number(b.distributable.ownerShare)).toBe(40000);
    expect(b.topProducts[0].code).toBe("D1"); expect(Number(b.topProducts[0].revenue)).toBe(1000000); expect(Number(b.topProducts[0].cost)).toBe(700000);
    expect(b.topCustomers[0].name).toBe("عميل الاختبار"); expect(b.expensesByCategory[0].name).toBe("إيجارات");
    expect(b.series.length).toBe(12); expect(Number(b.series[11].revenue)).toBe(1000000);
  });
  it("previous-period comparison (same length, immediately before) and custom ranges", async () => {
    const P = await w.mkProduct("D2"); await w.buy({ product: P, qty: "10", price: "1000", date: "2026-09-10" });
    await w.sale({ product: P, qty: "10", price: "2000", date: "2026-09-15" });                                          // 20,000 revenue in September
    const b = await get("?from=2026-10-01&to=2026-10-30");                                                                  // previous = 2026-09-01..2026-09-30
    expect(b.previousRange).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(Number(b.previous.revenue)).toBe(20000); expect(Number(b.period.revenue)).toBe(0); expect(Number(b.change.revenue)).toBe(-100);
    const sep = await get("?from=2026-09-01&to=2026-09-30"); expect(Number(sep.period.revenue)).toBe(20000); expect(Number(sep.period.cogs)).toBe(10000); expect(sep.integrity.balanced).toBe(true);
    const old = await get("?from=2020-01-01&to=2020-01-31"); expect(Number(old.period.revenue)).toBe(0); expect(old.integrity.balanced).toBe(true);
    expect((await w.api(w.owner, dash, { path: "/api/dashboard?from=2026-05-01&to=2026-04-01" } as any)).status).toBe(400);
  });
  it("alerts: overdue receivables and stale drafts; permission-gated; never invents problems", async () => {
    const P = await w.mkProduct("D3"); await w.buy({ product: P, qty: "5", price: "100", date: "2024-12-01" });
    const inv = await w.sale({ product: P, qty: "5", price: "500", date: "2025-01-01" });                                // due long ago
    expect(inv.status).toBe(200);
    const a = (await w.api(w.owner, alertsR)).body;
    expect(a.find((x: any) => x.code === "OVERDUE_RECEIVABLES").count).toBeGreaterThan(0);
    expect(a.some((x: any) => ["INVENTORY_MISMATCH", "NEGATIVE_CASH", "LIQUIDITY_SHORTFALL"].includes(x.code))).toBe(false);
    expect((await w.api(w.acct, alertsR)).status).toBe(200);                                                              // accountant has report:view by default
  });
});
