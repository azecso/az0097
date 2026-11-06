import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World; let P: string; let inv: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("10000000"); P = await w.mkProduct("PF"); await w.buy({ product: P, qty: "200", price: "7000", date: "2026-01-05" }); });
afterAll(async () => { await w.env.teardown(); });

const collect = async (invoiceId: string, amount: string, date: string) => {
  const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: date, cashAccountId: w.ids.cashIQD, currency: "IQD", amount, allocations: [{ invoiceId, amount }] } });
  const p = await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } }); if (p.status !== 200) throw new Error(JSON.stringify(p.body));
};
const ov = async () => (await w.api(w.owner, w.R.profits.GET)).body;
const wd = (o: Record<string, unknown>, s = w.owner) => w.api(s, w.R.profitWithdraw, { method: "POST", body: { cashAccountId: w.ids.cashIQD, docDate: "2026-04-10", idempotencyKey: crypto.randomUUID(), ...o } });

describe("live profit statement: expenses come out of PROFIT, never out of capital", () => {
  it("invoiced profit 300,000; expense 100,000 (accrued, unpaid) is deducted at once; net 200,000 split 100,000 / 100,000", async () => {
    inv = (await w.sale({ product: P, qty: "100", price: "10000", date: "2026-03-01" })).id;
    const none = await ov(); expect(none.invoicedProfit).toBe("300000"); expect(none.collectedProfit).toBe("0"); expect(none.distributable).toBe("0");   // nothing collected yet
    await collect(inv, "1000000", "2026-03-05");
    const e = await w.api(w.owner, w.R.expenses.POST, { method: "POST", body: { docDate: "2026-03-10", categoryId: await w.cat("إيجارات"), description: "إيجار المكتب", currency: "IQD", amount: "100000", paymentMode: "ACCRUED" } });
    expect((await w.api(w.owner, w.R.expensePost, { method: "POST", params: { id: e.body.id } })).status).toBe(200);
    const o = await ov();
    expect(o.collectedProfit).toBe("300000"); expect(o.expenses.total).toBe("100000"); expect(o.expenses.byAccount).toEqual([expect.objectContaining({ amount: "100000" })]);
    expect(o.netProfit).toBe("200000"); expect(o.distributable).toBe("200000"); expect(o.shares).toEqual({ owner: "100000", partner: "100000" });
    expect(o.capital).toBe("10000000");                                   // capital untouched by the expense
    expect(o.people.map((p: any) => [p.kind, p.available])).toEqual(expect.arrayContaining([["OWNER", "100000"], ["PARTNER", "100000"]]));
  });
  it("a PAID expense reduces cash (real money) and profit, but still not capital", async () => {
    const cashBefore = bal(await w.tb(), "1110");
    const e = await w.api(w.owner, w.R.expenses.POST, { method: "POST", body: { docDate: "2026-03-12", categoryId: await w.cat("إيجارات"), description: "صيانة", currency: "IQD", amount: "20000", paymentMode: "PAID_CASH", cashAccountId: w.ids.cashIQD } });
    await w.api(w.owner, w.R.expensePost, { method: "POST", params: { id: e.body.id } });
    const o = await ov(); expect(bal(await w.tb(), "1110")).toBe(cashBefore - 20000); expect(o.expenses.total).toBe("120000"); expect(o.distributable).toBe("180000"); expect(Number(o.capital)).toBe(10000000);
  });
});

describe("withdrawing profit: any person, no second approval, never above their share", () => {
  it("the owner pays 50,000 to the PARTNER: the live profit is approved automatically, one voucher, share reduced", async () => {
    const r = await wd({ partnerKind: "PARTNER", amount: "50000" });
    expect(r.status).toBe(200); expect(r.body.payouts).toHaveLength(1); expect(r.body.payouts[0].docNo).toMatch(/^PY-2026-/);
    const o = await ov(); const partner = o.people.find((p: any) => p.kind === "PARTNER"), owner = o.people.find((p: any) => p.kind === "OWNER");
    expect(partner).toMatchObject({ approved: "90000", paid: "50000", remainingApproved: "40000", available: "40000" }); expect(owner).toMatchObject({ approved: "90000", paid: "0", remainingApproved: "90000" });
    expect(o.payouts[0]).toMatchObject({ amount: "50000.0000", partner: expect.any(String) });
    expect(Number(o.capital)).toBe(10000000); expect((await w.tb()).balanced).toBe(true);
  });
  it("cannot exceed the person's remaining share; the other person's share is unaffected", async () => {
    expect((await wd({ partnerKind: "PARTNER", amount: "40001" })).body.error.code).toBe("EXCEEDS_PROFIT_SHARE");
    expect((await wd({ partnerKind: "PARTNER", amount: "40000" })).status).toBe(200);
    expect((await wd({ partnerKind: "PARTNER", amount: "1" })).body.error.code).toBe("EXCEEDS_PROFIT_SHARE");
    expect((await ov()).people.find((p: any) => p.kind === "OWNER").available).toBe("90000");
  });
  it("only the owner can withdraw; the same idempotency key is not paid twice", async () => {
    expect((await wd({ partnerKind: "OWNER", amount: "1000" }, w.acct)).status).toBe(403);
    const key = crypto.randomUUID(); expect((await wd({ partnerKind: "OWNER", amount: "1000", idempotencyKey: key })).status).toBe(200);
    expect((await wd({ partnerKind: "OWNER", amount: "1000", idempotencyKey: key })).status).toBe(409);
  });
  it("later profit and later expenses flow into the NEXT period automatically; one withdrawal can span two approved periods", async () => {
    const inv2 = (await w.sale({ product: P, qty: "50", price: "10000", date: "2026-05-01" })).id;       // profit 150,000
    await collect(inv2, "500000", "2026-05-02");
    const e = await w.api(w.owner, w.R.expenses.POST, { method: "POST", body: { docDate: "2026-05-03", categoryId: await w.cat("إيجارات"), description: "كهرباء", currency: "IQD", amount: "30000", paymentMode: "ACCRUED" } });
    await w.api(w.owner, w.R.expensePost, { method: "POST", params: { id: e.body.id } });
    const o = await ov(); expect(o.newlyEligible).toBe("150000"); expect(o.expenses.total).toBe("30000"); expect(o.distributable).toBe("120000");
    const owner = o.people.find((p: any) => p.kind === "OWNER"); expect(owner).toMatchObject({ remainingApproved: "89000", pending: "60000", available: "149000" });
    const r = await wd({ partnerKind: "OWNER", amount: "100000" });                                             // 89,000 from period 1 + 11,000 from the new period
    expect(r.status).toBe(200); expect(r.body.payouts.map((p: any) => p.amount)).toEqual(["89000", "11000"]);
    expect((await ov()).people.find((p: any) => p.kind === "OWNER")).toMatchObject({ paid: "101000", available: "49000" });
  });
  it("profit-payout voucher data and the optional 2FA switch", async () => {
    const o = await ov(); const id = o.payouts[0].id;
    expect((await w.api(w.owner, (await import("@/app/api/print-docs/[kind]/[id]/route")).GET, { params: { kind: "profit-payout", id } })).body).toMatchObject({ partner: expect.any(String), settlementNo: expect.stringMatching(/^PS-/) });
    expect((await w.api(w.owner, w.R.profitSettings.GET)).body.profitStepUp).toBe(false);
    expect((await w.api(w.acct, w.R.profitSettings.PUT, { method: "PUT", body: { profitStepUp: true } })).status).toBe(403);
    expect((await w.api(w.owner, w.R.profitSettings.PUT, { method: "PUT", body: { profitStepUp: true } })).status).toBe(200);
    const prev = process.env.REQUIRE_OWNER_2FA; process.env.REQUIRE_OWNER_2FA = "true";
    expect((await wd({ partnerKind: "OWNER", amount: "100" })).body.error.code).toBe("TOTP_SETUP_REQUIRED");      // switched on: the owner must enrol / enter a code again
    process.env.REQUIRE_OWNER_2FA = prev;
    await w.api(w.owner, w.R.profitSettings.PUT, { method: "PUT", body: { profitStepUp: false } });
  });
});
