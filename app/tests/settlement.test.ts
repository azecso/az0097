import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World; let P: string; let sale1: string; let set1: string; let set2: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("10000000"); P = await w.mkProduct("PS"); await w.buy({ product: P, qty: "200", price: "7000", date: "2026-01-05" }); });
afterAll(async () => { await w.env.teardown(); });

const collect = async (invoiceId: string, amount: string, date: string, acct?: string) => {
  const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: date, cashAccountId: acct ?? w.ids.cashIQD, currency: "IQD", amount, allocations: [{ invoiceId, amount }] } });
  const p = await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } }); if (p.status !== 200) throw new Error(JSON.stringify(p.body));
};
const preview = (start: string, end: string, extra: Record<string, unknown> = {}) => w.api(w.owner, w.R.settlePreview, { method: "POST", body: { periodStart: start, periodEnd: end, ...extra } });
const draft = async (start: string, end: string, extra: Record<string, unknown> = {}) => (await w.api(w.owner, w.R.settlements.POST, { method: "POST", body: { periodStart: start, periodEnd: end, ...extra } }));
const approve = (id: string, s = w.owner) => w.api(s, w.R.settleApprove, { method: "POST", params: { id }, body: {} });
const pay = (o: Record<string, unknown>, s = w.owner) => w.api(s, w.R.payouts.POST, { method: "POST", body: { docDate: "2026-04-10", cashAccountId: w.ids.cashIQD, deductAdvances: "0", ...o } });
const overview = async () => (await w.api(w.owner, w.R.partners)).body;

describe("TC-08 settlement: profit after expenses, split 50/50, partial payouts, no repeats", () => {
  it("collected profit 300,000 minus accrued payroll 100,000 => distributable 200,000 => 100,000 each", async () => {
    sale1 = (await w.sale({ product: P, qty: "100", price: "10000", date: "2026-03-01" })).id;
    // before collection nothing is eligible: profit is a restriction tied to collection
    const none = (await preview("2026-01-01", "2026-03-31")).body; expect(none.eligibleProfit).toBe("0"); expect(none.distributable).toBe("0");
    await collect(sale1, "1000000", "2026-03-05");
    await w.api(w.owner, w.R.employees.POST, { method: "POST", body: { name: "موظف", monthlySalary: "100000", currency: "IQD" } });
    await w.api(w.owner, w.R.payroll.POST, { method: "POST", body: { month: "2026-03" } });
    const acc = (await w.api(w.owner, w.R.payroll.GET, { path: "/api/payroll?month=2026-03" } as any)).body[0];
    await w.api(w.owner, w.R.payrollPost, { method: "POST", params: { id: acc.id } });                          // accrued, UNPAID — still deducted
    const pv = (await preview("2026-01-01", "2026-03-31")).body;
    expect(pv.eligibleProfit).toBe("300000"); expect(pv.deductions).toBe("100000"); expect(pv.distributable).toBe("200000");
    expect(pv.ownerShare).toBe("100000"); expect(pv.partnerShare).toBe("100000"); expect(pv.lines.length).toBe(1);
    const d = await draft("2026-01-01", "2026-03-31"); set1 = d.body.id; expect(d.body.draftRef).toMatch(/^DRAFT-/);
    expect((await w.api(w.acct, w.R.settleApprove, { method: "POST", params: { id: set1 }, body: {} })).status).toBe(403);     // owner only
    const before = await w.tb();
    const a = await approve(set1); expect(a.status).toBe(200); expect(a.body.docNo).toMatch(/^PS-2026-/);
    const tb = await w.tb();
    expect(bal(tb, "3400") - bal(before, "3400")).toBe(200000); expect(-bal(tb, "2500")).toBe(200000);
    const ov = await overview();
    expect(Number(ov.partners.find((p: any) => p.kind === "OWNER").dueProfit)).toBe(100000); expect(Number(ov.partners.find((p: any) => p.kind === "PARTNER").dueProfit)).toBe(100000);
  });
  it("the same profit can never be used again: re-approval, overlapping period, and the next period all yield nothing", async () => {
    expect((await approve(set1)).body.error.code).toBe("NOT_DRAFT");
    expect((await draft("2026-03-15", "2026-04-15")).body.error.code).toBe("PERIOD_OVERLAP");
    const next = (await preview("2026-04-01", "2026-04-30")).body;
    expect(next.eligibleProfit).toBe("0"); expect(next.deductions).toBe("0"); expect(next.distributable).toBe("0"); expect(next.lines.length).toBe(0);
    await expect(w.inject((tx) => tx`INSERT INTO profit_settlement_lines(company_id, settlement_id, invoice_id, adjusted_profit, collected_ratio, linked_profit, released_before, newly_released, released_after)
      SELECT company_id, ${set1}, ${sale1}, 300000, 1, 300000, 0, 300000, 300000 FROM profit_settlements WHERE id = ${set1}`)).rejects.toThrow();      // immutable / continuity
  });
  it("partial payouts with advances deducted; the replay and an over-share payout are refused; accountant cannot pay", async () => {
    const adv = await w.api(w.owner, w.R.advances.POST, { method: "POST", body: { partnerKind: "PARTNER", kind: "DRAW", docDate: "2026-04-01", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "30000" } });
    await w.api(w.owner, w.R.advancePost, { method: "POST", params: { id: adv.body.id } });
    expect((await pay({ settlementId: set1, partnerKind: "PARTNER", amount: "60000", idempotencyKey: "payout-key-0001" }, w.acct)).status).toBe(403);
    const cashBefore = bal(await w.tb(), "1110");
    const p1 = await pay({ settlementId: set1, partnerKind: "PARTNER", amount: "60000", deductAdvances: "30000", idempotencyKey: "payout-key-0001" });
    expect(p1.status).toBe(200); expect(p1.body.paidCash).toBe("30000"); expect(p1.body.advancesDeducted).toBe("30000");
    expect(bal(await w.tb(), "1110") - cashBefore).toBe(-30000); expect(bal(await w.tb(), "1250")).toBe(0);               // advance consumed
    const replay = await pay({ settlementId: set1, partnerKind: "PARTNER", amount: "60000", idempotencyKey: "payout-key-0001" });
    expect(replay.status).toBe(409); expect(replay.body.error.code).toBe("DUPLICATE_PAYOUT");
    const over = await pay({ settlementId: set1, partnerKind: "PARTNER", amount: "50000", idempotencyKey: "payout-key-0002" });
    expect(over.status).toBe(409); expect(over.body.error.code).toBe("PAYOUT_EXCEEDS_SHARE");                          // 60k + 50k > 100k
    expect((await pay({ settlementId: set1, partnerKind: "PARTNER", amount: "40000", idempotencyKey: "payout-key-0003" })).status).toBe(200);
    expect((await pay({ settlementId: set1, partnerKind: "OWNER", amount: "100000", idempotencyKey: "payout-key-0004" })).status).toBe(200);
    expect((await pay({ settlementId: set1, partnerKind: "OWNER", amount: "1", idempotencyKey: "payout-key-0005" })).body.error.code).toBe("PAYOUT_EXCEEDS_SHARE");
    expect(bal(await w.tb(), "2500")).toBe(0);
    const st = (await w.api(w.owner, w.R.partnerStatement, { params: { id: (await overview()).partners.find((p: any) => p.kind === "PARTNER").id } })).body;
    expect(Number(st.netDue)).toBe(0); expect(st.lines.length).toBeGreaterThan(3);
    expect((await w.api(w.owner, w.R.settleReverse, { method: "POST", params: { id: set1 }, body: { reason: "اختبار" } })).body.error.code).toBe("HAS_PAYOUTS");
  });
});

describe("liquidity: payouts never exceed cash minus committed obligations", () => {
  it("a supplier invoice that is due soon is a committed obligation and blocks a payout that would use that cash", async () => {
    const sale2 = (await w.sale({ product: P, qty: "100", price: "10000", date: "2026-05-01" })).id;
    await collect(sale2, "1000000", "2026-05-02");
    const e = await w.api(w.owner, w.R.expenses.POST, { method: "POST", body: { docDate: "2026-05-15", currency: "IQD", description: "إيجار مستحق", categoryId: await w.cat("إيجارات"), amount: "100000", paymentMode: "ACCRUED" } });
    await w.api(w.owner, w.R.expensePost, { method: "POST", params: { id: e.body.id } });
    const pv = (await preview("2026-04-01", "2026-06-30")).body;
    expect(pv.eligibleProfit).toBe("300000"); expect(pv.deductions).toBe("100000"); expect(pv.distributable).toBe("200000");
    set2 = (await draft("2026-04-01", "2026-06-30")).body.id; expect((await approve(set2)).status).toBe(200);
    const liq = (await overview()).liquidity; const avail = Number(liq.available);
    const big = await w.mkProduct("LIQ"); const target = 50000;                                        // leave exactly 50,000 distributable
    await w.buy({ product: big, qty: "1", price: String(avail - target), type: "CREDIT", date: "2026-06-01" });
    expect(Number((await overview()).liquidity.available)).toBe(target);
    const blocked = await pay({ settlementId: set2, partnerKind: "OWNER", amount: "100000", idempotencyKey: "liq-key-0001" });
    expect(blocked.status).toBe(409); expect(blocked.body.error.code).toBe("INSUFFICIENT_LIQUIDITY");
    expect((await pay({ settlementId: set2, partnerKind: "OWNER", amount: "40000", idempotencyKey: "liq-key-0002" })).status).toBe(200);
    const rv = await import("@/app/api/profit-payouts/[id]/reverse/route");
    const po = (await w.api(w.owner, w.R.payouts.GET)).body.find((x: any) => x.settlementNo === "PS-2026-000002" || x.amount === "40000.0000");
    expect((await w.api(w.owner, rv.POST, { method: "POST", params: { id: po.id }, body: { reason: "دفعة خاطئة" } })).status).toBe(200);
    expect((await pay({ settlementId: set2, partnerKind: "OWNER", amount: "40000", idempotencyKey: "liq-key-0003" })).status).toBe(200);        // reversed amount is payable again
  });
});

describe("losses are carried forward and covered before any later distribution", () => {
  let sale3: string;
  it("period result negative: no distribution, loss carried; later profit first covers the loss (no debt on the partner)", async () => {
    await w.buy({ product: P, qty: "100", price: "7000", date: "2026-07-01" });
    sale3 = (await w.sale({ product: P, qty: "100", price: "10000", date: "2026-07-15" })).id;
    await collect(sale3, "100000", "2026-07-20");                                                       // 10% collected => linked 30,000
    const e = await w.api(w.owner, w.R.expenses.POST, { method: "POST", body: { docDate: "2026-08-01", currency: "IQD", description: "مصاريف كبيرة", categoryId: await w.cat("صيانة"), amount: "500000", paymentMode: "ACCRUED" } });
    await w.api(w.owner, w.R.expensePost, { method: "POST", params: { id: e.body.id } });
    const pv = (await preview("2026-07-01", "2026-09-30")).body;
    expect(pv.eligibleProfit).toBe("30000"); expect(pv.deductions).toBe("500000"); expect(pv.periodResult).toBe("-470000");
    expect(pv.distributable).toBe("0"); expect(pv.lossCarriedOut).toBe("470000");
    const s3 = (await draft("2026-07-01", "2026-09-30")).body.id; expect((await approve(s3)).status).toBe(200);
    const none = await pay({ settlementId: s3, partnerKind: "OWNER", amount: "1", idempotencyKey: "loss-key-0001" });
    expect(none.status).toBe(409);                                                                       // nothing to pay (no share rows with value)
    expect(Number((await overview()).lossCarriedForward)).toBe(470000);
    await collect(sale3, "900000", "2026-10-05");                                                       // rest collected => linked 300,000 (270,000 newly)
    const pv2 = (await preview("2026-10-01", "2026-10-31")).body;
    expect(pv2.eligibleProfit).toBe("270000"); expect(pv2.lossCarriedIn).toBe("470000"); expect(pv2.lossCovered).toBe("270000");
    expect(pv2.distributable).toBe("0"); expect(pv2.lossCarriedOut).toBe("200000");                     // loss absorbs the whole profit
    const s4 = (await draft("2026-10-01", "2026-10-31")).body.id; expect((await approve(s4)).status).toBe(200);
    expect(Number((await overview()).lossCarriedForward)).toBe(200000);
  });
  it("D-08: a return AFTER an approved settlement shows up as a negative eligible profit in the next one (no retroactive edit)", async () => {
    const g = await w.getInvoice(sale1);
    const rd = await w.api(w.owner, w.R.sreturns.POST, { method: "POST", body: { invoiceId: sale1, docDate: "2026-11-01", reason: "مرتجع بعد التسوية", settlement: "REDUCE_RECEIVABLE", lines: [{ salesLineId: g.lines[0].id, qtyBase: "10" }] } });
    await w.api(w.owner, w.R.sreturnPost, { method: "POST", params: { id: rd.body.id } });
    const pv = (await preview("2026-11-01", "2026-11-30")).body;
    expect(pv.eligibleProfit).toBe("-30000");                                                           // sale 1: released 300,000 -> adjusted 270,000
    expect(pv.lines.find((l: any) => l.invoiceId === sale1).newly).toBe("-30000");
    expect(Number(pv.distributable)).toBe(0);
  });
  it("only the latest settlement can be reversed; reversal frees its profit again; owner only", async () => {
    const list = (await w.api(w.owner, w.R.settlements.GET)).body.filter((s: any) => s.status === "POSTED");
    const first = list[list.length - 1], latest = list[0];
    expect((await w.api(w.owner, w.R.settleReverse, { method: "POST", params: { id: first.id }, body: { reason: "اختبار" } })).body.error.code).toMatch(/HAS_PAYOUTS|NOT_LATEST/);
    expect((await w.api(w.acct, w.R.settleReverse, { method: "POST", params: { id: latest.id }, body: { reason: "اختبار" } })).status).toBe(403);
    const r = await w.api(w.owner, w.R.settleReverse, { method: "POST", params: { id: latest.id }, body: { reason: "تصحيح الفترة" } });
    expect(r.status).toBe(200);
    expect((await preview("2026-10-01", "2026-10-31")).body.eligibleProfit).toBe("270000");              // sale 3's 270,000 is available again; the November return is dated after the cut-off and does NOT leak into October
    expect((await preview("2026-10-01", "2026-11-30")).body.eligibleProfit).toBe("240000");              // ...it only appears once the period reaches its date (-30,000)
    expect((await w.tb()).balanced).toBe(true);
  });
  it("opening-balance receivables never count as profit", async () => {
    const rows = await w.env.admin`SELECT count(*)::int n FROM profit_settlement_lines l JOIN sales_invoices s ON s.id = l.invoice_id WHERE s.is_opening`;
    expect(rows[0]!.n).toBe(0);
    expect((await w.recon()).ok).toBe(true);
  });
});
