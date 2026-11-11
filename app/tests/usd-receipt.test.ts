import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World; let P: string; let seq = 0;
beforeAll(async () => { w = await makeWorld(); await w.fund("20000000"); P = await w.mkProduct("US"); await w.buy({ product: P, qty: "500", price: "800", date: "2026-02-01" }); });
afterAll(async () => { await w.env.teardown(); });

const usdRoute = async () => (await import("@/app/api/customer-receipts/usd/route")).POST;
const amendRoute = async () => (await import("@/app/api/customer-receipts/[id]/amend-usd/route")).POST;
const cashNet = async (acct: string) => Number((await w.env.admin`SELECT COALESCE(sum(amount),0)::text AS s FROM cash_movements WHERE cash_account_id = ${acct}`)[0]!.s);
const invoice = async (price: string, qty = "1") => { const id = (await w.sale({ product: P, qty, price, date: "2026-05-01", type: "CREDIT" })).id; return { id, g: await w.getInvoice(id) }; };
const body = (inv: any, o: Record<string, unknown> = {}) => { const base: any = { requestId: `usd-${++seq}-${Math.random().toString(36).slice(2)}`, invoiceId: inv.id, customerId: inv.g.customerId, docDate: "2026-05-02", cashAccountId: w.ids.cashUSD, usdAmount: "100", keepRemainder: false, expectedOutstanding: String(Number(inv.g.net)), ...o };
  if (!base.keepRemainder && base.fullSettlementConfirmation === undefined) base.fullSettlementConfirmation = { invoiceId: base.invoiceId, customerId: base.customerId, cashAccountId: base.cashAccountId, usdAmount: base.usdAmount, outstandingBefore: base.expectedOutstanding };
  return base; };
const call = async (b: unknown, session = w.owner) => w.api(session, await usdRoute(), { method: "POST", body: b });

describe("USD received against a dinar invoice", () => {
  it("full settlement with explicit confirmation: 150000 IQD for 100 USD -> remaining 0, only the USD box moves, books balance, no FX gain/loss", async () => {
    const inv = await invoice("150000"); const iqd0 = await cashNet(w.ids.cashIQD), usd0 = await cashNet(w.ids.cashUSD), fx0 = bal(await w.tb(), "7100");
    const r = await call(body(inv)); expect(r.status).toBe(200); expect(r.body).toMatchObject({ settledIqd: "150000", usd: "100", outstanding: "0", status: "PAID" });
    expect(Number(r.body.impliedRate)).toBe(1500);
    expect(await cashNet(w.ids.cashUSD) - usd0).toBe(100); expect(await cashNet(w.ids.cashIQD)).toBe(iqd0); expect(bal(await w.tb(), "7100")).toBe(fx0);
    const g = await w.getInvoice(inv.id); expect(g).toMatchObject({ currency: "IQD", outstanding: "0" });
    expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
  });
  it("without the confirmation object the server refuses to zero the invoice; nothing is created", async () => {
    const inv = await invoice("150000"); const usd0 = await cashNet(w.ids.cashUSD);
    const b = body(inv); delete b.fullSettlementConfirmation; const r = await call(b); expect(r.status).toBe(409); expect(r.body.error.code).toBe("FULL_SETTLEMENT_CONFIRMATION_REQUIRED");
    expect(await cashNet(w.ids.cashUSD)).toBe(usd0); expect((await w.getInvoice(inv.id)).outstanding).toBe("150000");
  });
  it("a confirmation for other values (dollars / account / balance) does not authorise this operation", async () => {
    const inv = await invoice("150000"); const b = body(inv, { usdAmount: "90" }); b.fullSettlementConfirmation.usdAmount = "100";
    expect((await call(b)).body.error.code).toBe("FULL_SETTLEMENT_CONFIRMATION_REQUIRED");
    const b2 = body(inv); b2.fullSettlementConfirmation.outstandingBefore = "149999"; expect((await call(b2)).body.error.code).toBe("FULL_SETTLEMENT_CONFIRMATION_REQUIRED");
    expect((await w.getInvoice(inv.id)).outstanding).toBe("150000");
  });
  it("partial: 100 USD with 20000 left -> settles 130000, remaining 20000; implied rate 1300 documented", async () => {
    const inv = await invoice("150000"); const iqd0 = await cashNet(w.ids.cashIQD), usd0 = await cashNet(w.ids.cashUSD);
    const r = await call(body(inv, { keepRemainder: true, remainingIqd: "20000", fullSettlementConfirmation: null })); expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ settledIqd: "130000", outstanding: "20000", status: "PARTIAL" }); expect(Number(r.body.impliedRate)).toBe(1300);
    expect(await cashNet(w.ids.cashUSD) - usd0).toBe(100); expect(await cashNet(w.ids.cashIQD)).toBe(iqd0);
    expect((await w.getInvoice(inv.id)).outstanding).toBe("20000"); expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
  });
  it("invoice already partly collected: balance and remaining are against what is still owed", async () => {
    const inv = await invoice("150000"); const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: inv.g.customerId, docDate: "2026-05-02", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "50000", allocations: [{ invoiceId: inv.id, amount: "50000" }] } });
    await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } });
    const r = await call(body(inv, { usdAmount: "50", expectedOutstanding: "100000", keepRemainder: true, remainingIqd: "25000", fullSettlementConfirmation: null })); expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ settledIqd: "75000", outstanding: "25000" }); expect(Number(r.body.impliedRate)).toBe(1500);
  });
  it("validation: remaining must be positive and below the current balance; dollars positive; USD box required; stale balance refused", async () => {
    const inv = await invoice("150000");
    for (const rem of ["0", "150000", "160000", "-5"]) expect((await call(body(inv, { keepRemainder: true, remainingIqd: rem, fullSettlementConfirmation: null }))).status).toBeGreaterThanOrEqual(400);
    expect((await call(body(inv, { keepRemainder: true, remainingIqd: null, fullSettlementConfirmation: null }))).body.error.code).toBe("REMAINING_REQUIRED");
    expect((await call(body(inv, { usdAmount: "0", keepRemainder: true, remainingIqd: "100" }))).status).toBeGreaterThanOrEqual(400);
    expect((await call(body(inv, { cashAccountId: w.ids.cashIQD, keepRemainder: true, remainingIqd: "1000", fullSettlementConfirmation: null }))).body.error.code).toBe("USD_CASH_ACCOUNT_REQUIRED");
    expect((await call(body(inv, { expectedOutstanding: "140000", keepRemainder: true, remainingIqd: "1000", fullSettlementConfirmation: null }))).body.error.code).toBe("STALE_BALANCE");
    expect((await w.getInvoice(inv.id)).outstanding).toBe("150000");
  });
  it("another operation changed the balance after the screen was opened: full settlement is refused with the new figure, not applied on the old balance", async () => {
    const inv = await invoice("150000"); const shown = body(inv);
    await call(body(inv, { usdAmount: "40", keepRemainder: true, remainingIqd: "90000", fullSettlementConfirmation: null }));      // someone else paid
    const r = await call(shown); expect(r.status).toBe(409); expect(r.body.error.code).toBe("STALE_BALANCE"); expect((await w.getInvoice(inv.id)).outstanding).toBe("90000");
  });
  it("same requestId twice (double click) creates one receipt; concurrent identical requests too", async () => {
    const inv = await invoice("150000"); const b = body(inv); const usd0 = await cashNet(w.ids.cashUSD);
    const [a, c] = await Promise.all([call(b), call(b)]); const ok = [a, c].filter((x) => x.status === 200); expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(await cashNet(w.ids.cashUSD) - usd0).toBe(100);
    expect((await call(b)).body.replayed).toBe(true); expect(await cashNet(w.ids.cashUSD) - usd0).toBe(100);
  });
  it("correct after posting (keeps number, balance and boxes follow), then cancel restores everything; no double reversal", async () => {
    const inv = await invoice("150000"); const iqd0 = await cashNet(w.ids.cashIQD), usd0 = await cashNet(w.ids.cashUSD);
    const r = await call(body(inv, { keepRemainder: true, remainingIqd: "20000", fullSettlementConfirmation: null })); const rid = r.body.receiptId as string;
    const form = (await w.api(w.owner, w.R.receiptEdit, { params: { id: rid } })).body; expect(form).toMatchObject({ usdSettlement: true, remainingAfter: "20000.0000" });
    const A = await amendRoute();
    const e = await w.api(w.owner, A, { method: "POST", params: { id: rid }, body: { invoiceId: inv.id, customerId: inv.g.customerId, docDate: "2026-05-03", cashAccountId: w.ids.cashUSD, usdAmount: "80", keepRemainder: true, remainingIqd: "30000", expectedOutstanding: "150000", version: form.version } });
    expect(e.status).toBe(200); expect(e.body.docNo).toBe(form.docNo);
    expect(await cashNet(w.ids.cashUSD) - usd0).toBe(80); expect((await w.getInvoice(inv.id)).outstanding).toBe("30000"); expect(await cashNet(w.ids.cashIQD)).toBe(iqd0);
    const stale = await w.api(w.owner, A, { method: "POST", params: { id: rid }, body: { invoiceId: inv.id, customerId: inv.g.customerId, docDate: "2026-05-03", cashAccountId: w.ids.cashUSD, usdAmount: "80", keepRemainder: true, remainingIqd: "30000", expectedOutstanding: "150000", version: 1 } });
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
    const plain = await w.api(w.owner, w.R.receiptAmend, { method: "POST", params: { id: rid }, body: { customerId: inv.g.customerId, docDate: "2026-05-03", kind: "CASH", cashAccountId: w.ids.cashUSD, currency: "USD", settlementRate: "1500", amount: "80", allocations: [], version: (await w.api(w.owner, w.R.receiptEdit, { params: { id: rid } })).body.version } });
    expect(plain.body.error.code).toBe("USE_USD_AMEND");
    expect((await w.api(w.owner, w.R.receiptReverse, { method: "POST", params: { id: rid }, body: { reason: "إلغاء" } })).status).toBe(200);
    expect(await cashNet(w.ids.cashUSD)).toBe(usd0); expect((await w.getInvoice(inv.id)).outstanding).toBe("150000"); expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
  });
  it("reports and print separate USD actually received, the settlement equivalent and the remaining; the equivalent is not shown as dinar cash", async () => {
    const inv = await invoice("150000"); const cust = inv.g.customerId;
    const stRow = async () => (await w.api(w.owner, w.R.report2, { params: { id: "customers" }, path: `/api/reports2/customers?partyId=${cust}` } as any)).body.rows.find((x: any) => x.currency === "IQD");
    const before = await stRow();
    const r = await call(body(inv, { usdAmount: "100", keepRemainder: true, remainingIqd: "20000", fullSettlementConfirmation: null })); expect(r.status).toBe(200);
    const row = await stRow();
    expect(Number(row.usdEq) - Number(before.usdEq)).toBe(130000); expect(Number(row.usdReceived) - Number(before.usdReceived)).toBe(100); expect(Number(row.cash) - Number(before.cash)).toBe(0);
    const back = (await w.api(w.owner, w.R.report2, { params: { id: "customers" }, path: `/api/reports2/customers?partyId=${cust}` } as any)).body.rows.find((x: any) => x.currency === "IQD");
    expect(Number(back.closing)).toBe(Number(row.invoices) - Number(row.cash) - Number(row.usdEq) - Number(row.returns) - Number(row.external) - Number(row.applied) - Number(row.other));
    const det = (await w.api(w.owner, w.R.report2, { params: { id: "customer-invoices" }, path: `/api/reports2/customer-invoices?partyId=${cust}` } as any)).body.rows as any[];
    const mv = det.find((x) => x.invoiceNo === inv.g.docNo && String(x.type).includes("قبض دولار")); expect(mv.note).toContain("100 USD"); expect(mv.note).toContain("20000"); expect(Number(mv.amount)).toBe(130000);
    const pr = (await w.api(w.owner, (await import("@/app/api/customer-receipts/[id]/route")).GET, { params: { id: r.body.receiptId } })).body;
    expect(pr).toMatchObject({ usdSettlement: true, currency: "USD", remainingAfter: "20000.0000" }); expect(Number(pr.outstandingBefore)).toBe(150000); expect(Number(pr.amount)).toBe(100);
  });
  it("a failed operation leaves nothing behind", async () => {
    const inv = await invoice("150000"); const usd0 = await cashNet(w.ids.cashUSD); const n0 = Number((await w.env.admin`SELECT count(*)::int AS n FROM customer_receipts`)[0]!.n);
    expect((await call(body(inv, { usdAmount: "1", keepRemainder: true, remainingIqd: "10", fullSettlementConfirmation: null }))).status).toBeGreaterThanOrEqual(400);   // implied rate 149990: out of range
    expect(Number((await w.env.admin`SELECT count(*)::int AS n FROM customer_receipts`)[0]!.n)).toBe(n0); expect(await cashNet(w.ids.cashUSD)).toBe(usd0);
  });
});
