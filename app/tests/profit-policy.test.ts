import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("20000000"); P = await w.mkProduct("PP"); await w.buy({ product: P, qty: "500", price: "1000", date: "2026-01-05" }); });
afterAll(async () => { await w.env.teardown(); });

const collect = async (invoiceId: string, amount: string, date: string, extra: Record<string, unknown> = {}) => {
  const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: date, cashAccountId: w.ids.cashIQD, currency: "IQD", amount, allocations: [{ invoiceId, amount, ...extra }] } });
  if (rc.status !== 200) return rc;
  return w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } });
};
const preview = (start: string, end: string, extra: Record<string, unknown> = {}) => w.api(w.owner, w.R.settlePreview, { method: "POST", body: { periodStart: start, periodEnd: end, ...extra } });
const draft = (start: string, end: string, extra: Record<string, unknown> = {}) => w.api(w.owner, w.R.settlements.POST, { method: "POST", body: { periodStart: start, periodEnd: end, ...extra } });
const approve = (id: string) => w.api(w.owner, w.R.settleApprove, { method: "POST", params: { id }, body: {} });
const deliver = async (inv: string, qty: string, date: string) => {
  const g = await w.getInvoice(inv);
  const d1 = await w.api(w.owner, w.R.deliveries.POST, { method: "POST", body: { invoiceId: inv, docDate: date, lines: [{ salesLineId: g.lines[0].id, qtyBase: qty }] } });
  return w.api(w.owner, w.R.deliveryPost, { method: "POST", params: { id: d1.body.id } });
};
const acct = async (code: string) => bal(await w.tb(), code);

describe("A. an invoice collected before delivery is not profit; revenue follows delivery", () => {
  let inv: string;
  it("SEPARATE invoice 10 x 2,000: value sits in deferred revenue (2600), no sales yet", async () => {
    inv = (await w.sale({ product: P, qty: "10", price: "2000", date: "2026-02-01", mode: "SEPARATE" })).id;
    expect(await acct("2600")).toBe(-20000); expect(await acct("4100")).toBe(0);
  });
  it("collected in full before any delivery => eligible profit 0 (was 20,000)", async () => {
    expect((await collect(inv, "20000", "2026-02-02")).status).toBe(200);
    const pv = (await preview("2026-01-01", "2026-02-28")).body; expect(pv.eligibleProfit).toBe("0"); expect(pv.distributable).toBe("0");
  });
  it("delivering 4 of 10 earns 4 x (2,000 - 1,000) = 4,000, revenue 8,000 moves from 2600 to 4100", async () => {
    expect((await deliver(inv, "4", "2026-02-10")).status).toBe(200);
    expect(await acct("4100")).toBe(-8000); expect(await acct("2600")).toBe(-12000);
    expect((await preview("2026-01-01", "2026-02-28")).body.eligibleProfit).toBe("4000");
  });
  it("delivering the rest earns the full 10,000 and empties 2600 exactly", async () => {
    expect((await deliver(inv, "6", "2026-02-12")).status).toBe(200);
    expect(await acct("2600")).toBe(0); expect(await acct("4100")).toBe(-20000);
    expect((await preview("2026-01-01", "2026-02-28")).body.eligibleProfit).toBe("10000");
    expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
  });
  it("delivery cannot be dated before its invoice", async () => {
    const i2 = (await w.sale({ product: P, qty: "1", price: "2000", date: "2026-04-01", mode: "SEPARATE" })).id;
    expect((await deliver(i2, "1", "2026-03-01")).body.error.code).toBe("DELIVERY_BEFORE_INVOICE");
  });
});

describe("B. cut-off: nothing dated after the period end leaks into an earlier settlement", () => {
  it("a collection dated after the end is excluded, then picked up by the next period exactly once", async () => {
    expect((await approve((await draft("2026-01-01", "2026-04-30")).body.id)).status).toBe(200);              // settle what exists so far (A's 10,000)
    const inv = (await w.sale({ product: P, qty: "10", price: "3000", date: "2026-05-01" })).id;            // profit 20,000 when fully collected
    await collect(inv, "15000", "2026-05-10");                                                               // half of 30,000 -> linked 10,000
    await collect(inv, "15000", "2026-06-10");                                                               // after the May cut-off
    const may = (await preview("2026-05-01", "2026-05-31")).body; expect(may.eligibleProfit).toBe("10000");
    const s1 = (await draft("2026-05-01", "2026-05-31")).body.id; expect((await approve(s1)).status).toBe(200);
    const jun = (await preview("2026-06-01", "2026-06-30")).body; expect(jun.eligibleProfit).toBe("10000");
    expect(jun.lines.find((l: any) => l.invoiceId === inv).before).toBe("10000");
  });
  it("a delivery dated after the end is excluded from that settlement's profit", async () => {
    const inv = (await w.sale({ product: P, qty: "5", price: "2000", date: "2026-07-01", mode: "SEPARATE" })).id;
    await collect(inv, "10000", "2026-07-02"); await deliver(inv, "5", "2026-08-05");
    expect((await preview("2026-07-01", "2026-07-31")).body.lines.find((l: any) => l.invoiceId === inv)).toBeUndefined();
    expect((await preview("2026-07-01", "2026-08-31")).body.lines.find((l: any) => l.invoiceId === inv).newly).toBe("5000");
  });
});

describe("E. reserve: held-back profit is a visible balance, released later with a reason, never lost or doubled", () => {
  it("reserve 4,000 now, the settlement distributes the rest; a later settlement releases it", async () => {
    expect((await approve((await draft("2026-06-01", "2026-08-31")).body.id)).status).toBe(200);               // catch up June/July/August
    const inv = (await w.sale({ product: P, qty: "10", price: "2000", date: "2026-09-02" })).id; await collect(inv, "20000", "2026-09-03");       // profit 10,000
    const noReason = await draft("2026-09-01", "2026-09-30", { reserved: "4000" }); expect(noReason.status).toBe(400);
    const d1 = await draft("2026-09-01", "2026-09-30", { reserved: "4000", reservedReason: "احتياطي طوارئ" }); expect(d1.status).toBe(200);
    const a1 = await approve(d1.body.id); expect(a1.status).toBe(200); expect(a1.body.distributable).toBe("6000"); expect(a1.body.reserveAfter).toBe("4000");
    const rel = await preview("2026-10-01", "2026-10-31", { releaseReserve: "4000" }); expect(rel.status).toBe(400);                  // reason required
    const ok = (await preview("2026-10-01", "2026-10-31", { releaseReserve: "4000", releaseReason: "انتهت الحاجة" })).body;
    expect(ok.distributable).toBe("4000"); expect(ok.reserveAfter).toBe("0");
    expect((await preview("2026-10-01", "2026-10-31", { releaseReserve: "4001", releaseReason: "x" })).body.error.code).toBe("RELEASE_EXCEEDS_RESERVE");
  });
  it("a reserve larger than what can be distributed is refused", async () => {
    const r = await preview("2026-10-01", "2026-10-31", { reserved: "999999", reservedReason: "x" }); expect(r.status).toBe(409);
  });
});

describe("K. outside-distributed profit is a non-cash settlement bounded by the invoice's earned profit", () => {
  it("cannot exceed the earned profit, and cannot be recorded for goods not yet delivered", async () => {
    const inv = (await w.sale({ product: P, qty: "1", price: "1500", date: "2026-11-01" })).id;                // profit 500
    const bad = await collect(inv, "800", "2026-11-02", { externalAmount: "700" }); expect(bad.status).toBe(409); expect(bad.body.error.code).toBe("EXTERNAL_EXCEEDS_PROFIT");
    const ok = await collect(inv, "1000", "2026-11-02", { externalAmount: "500" }); expect(ok.status).toBe(200);
    expect((await w.getInvoice(inv)).outstanding).toBe("0");
    const sep = (await w.sale({ product: P, qty: "1", price: "1500", date: "2026-11-03", mode: "SEPARATE" })).id;
    expect((await collect(sep, "1000", "2026-11-04", { externalAmount: "500" })).body.error.code).toBe("EXTERNAL_EXCEEDS_PROFIT");   // nothing delivered => no earned profit
  });
});
