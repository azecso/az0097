import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeWorld, type World } from "./world";
import { hotp, stepOf } from "@/lib/totp";

let w: World; let secret = ""; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("20000000"); P = await w.mkProduct("TP"); await w.buy({ product: P, qty: "500", price: "1000", date: "2026-01-05" }); });
afterAll(async () => { vi.useRealTimers(); process.env.REQUIRE_OWNER_2FA = "false"; await w.env.teardown(); });
const at = (steps: number) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + steps * 30_000); };
const code = () => hotp(secret, stepOf());
const wd = (amount: string, c: string | null, key: string) => w.api(w.owner, w.R.profitWithdraw, { method: "POST", body: { partnerKind: "OWNER", amount, cashAccountId: w.ids.cashIQD, docDate: "2026-12-20", idempotencyKey: key, totp: c } });
const earn = async (date: string) => { const inv = (await w.sale({ product: P, qty: "10", price: "2000", date })).id;
  const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: date, cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "20000", allocations: [{ invoiceId: inv, amount: "20000" }] } });
  await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } }); };

describe("one TOTP code covers a whole request (approve + several payouts) but is never reusable across requests", () => {
  it("setup: enrol 2FA and switch the profit step-up on", async () => {
    process.env.REQUIRE_OWNER_2FA = "true";
    const s = await w.api(w.owner, w.R.totp.POST, { method: "POST", body: { action: "setup" } }); secret = s.body.secret;
    at(1); expect((await w.api(w.owner, w.R.totp.POST, { method: "POST", body: { action: "enable", code: code() } })).status).toBe(200);
    expect((await w.api(w.owner, w.R.profitSettings.PUT, { method: "PUT", body: { profitStepUp: true } })).status).toBe(200);
  });
  it("withdrawal that needs an automatic approval AND a payout works with a single code", async () => {
    await earn("2026-03-01");                                                  // profit 10,000
    at(1); const c = code();
    const r = await wd("3000", c, "multi-key-0001"); expect(r.status, JSON.stringify(r.body)).toBe(200); expect(r.body.payouts).toHaveLength(1);
  });
  it("a withdrawal spanning two approved settlements consumes the code once, not once per payout", async () => {
    await earn("2026-04-01"); at(1); const c1 = code();
    expect((await wd("1000", c1, "multi-key-0002")).status).toBe(200);          // approves period 2 (and pays 1,000 of it)
    // now there is remaining share in settlement 1 and settlement 2: ask for more than the first one holds
    at(1); const c2 = code();
    const r = await wd("6000", c2, "multi-key-0003"); expect(r.status, JSON.stringify(r.body)).toBe(200); expect(r.body.payouts.length).toBeGreaterThanOrEqual(2);
  });
  it("the same code is still refused in a separate request", async () => {
    await earn("2026-05-01"); at(1); const c = code();
    expect((await wd("500", c, "multi-key-0004")).status).toBe(200);
    expect((await wd("500", c, "multi-key-0005")).body.error.code).toBe("TOTP_REPLAYED");
  });
});
