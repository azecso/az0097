import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("10000000"); P = await w.mkProduct("CA"); await w.buy({ product: P, qty: "100", price: "1000", date: "2026-01-05" }); });
afterAll(async () => { await w.env.teardown(); });
const accounts = async () => (await w.api(w.owner, w.R.cash)).body as any[];
const post = (b: unknown, s = w.owner) => w.api(s, w.R.cashAccounts.POST, { method: "POST", body: b });

describe("cash accounts per currency; USD partner custody", () => {
  it("every company has a USD custody account that is restricted money", async () => {
    const c = (await accounts()).find((a: any) => a.kind === "PARTNER_CUSTODY" && a.currency === "USD"); expect(c).toBeDefined(); expect(c.countsTowardAvailable).toBe(false);
  });
  it("the partner collects dollars into USD custody and hands them over by a transfer, not income", async () => {
    const cust = (await accounts()).find((a: any) => a.kind === "PARTNER_CUSTODY" && a.currency === "USD").id;
    const inv = (await w.sale({ product: P, qty: "10", price: "10", date: "2026-02-01", currency: "USD", rate: "1500" })).id;
    const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-02-05", cashAccountId: cust, currency: "USD", exchangeRate: "1500", amount: "100", allocations: [{ invoiceId: inv, amount: "100" }] } });
    expect((await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } })).status).toBe(200);
    expect(Number((await accounts()).find((a: any) => a.id === cust).balance)).toBe(100);
    const t = await w.api(w.owner, w.R.ctransfers.POST, { method: "POST", body: { docDate: "2026-02-06", fromAccountId: cust, toAccountId: w.ids.cashUSD, amount: "100" } });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect((await w.api(w.owner, w.R.ctransferPost, { method: "POST", params: { id: t.body.id } })).status).toBe(200);
    expect(Number((await accounts()).find((a: any) => a.id === w.ids.cashUSD).balance)).toBe(100); expect((await w.tb()).balanced).toBe(true);
  });
  it("only the owner can add a bank account; it gets its own ledger account and works", async () => {
    expect((await post({ name: "مصرف الرافدين", currency: "IQD", kind: "BANK" }, w.acct)).status).toBe(403);
    const r = await post({ name: "مصرف الرافدين", currency: "IQD", kind: "BANK" }); expect(r.status, JSON.stringify(r.body)).toBe(200); expect(r.body.code).toMatch(/^11[3-9]\d$/);
    const b = (await accounts()).find((a: any) => a.id === r.body.id); expect(b).toMatchObject({ currency: "IQD", kind: "BANK", countsTowardAvailable: true });
    const t = await w.api(w.owner, w.R.ctransfers.POST, { method: "POST", body: { docDate: "2026-02-07", fromAccountId: w.ids.cashIQD, toAccountId: r.body.id, amount: "1000" } });
    await w.api(w.owner, w.R.ctransferPost, { method: "POST", params: { id: t.body.id } });
    expect(bal(await w.tb(), r.body.code)).toBe(1000);
  });
});
