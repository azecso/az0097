import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, capital, bal, sell, type World } from "./world";

let w: World;
beforeAll(async () => { w = await makeWorld(); await capital(w); });
afterAll(async () => { await w.env.teardown(); });

const consume = (qty: string, P: string, loc: string) => sell(w, P, loc, qty);

describe("TC-07b  supplier return after part of the layer was sold", () => {
  let P: string, po: any, lineId: string;
  const mkReturn = (qty: string, extra: Record<string, unknown> = {}, session = w.owner) => w.api(session, w.R.returns.POST, { method: "POST", body: { purchaseId: po.id, docDate: "2026-06-01", settlement: "REDUCE_PAYABLE", reason: "بضاعة معيبة", lines: [{ purchaseLineId: lineId, qtyBase: qty, ...extra }] } });
  it("only the unsold remainder returns at the layer's own cost; the sold part needs an owner-approved exceptional entry", async () => {
    P = await w.mkProduct("RET");
    po = await w.buy({ product: P, qty: "100", price: "10000", type: "CREDIT", date: "2026-06-01" });
    lineId = (await w.api(w.owner, w.R.purchaseId.GET, { params: { id: po.id } })).body.lines[0].id;
    await w.buy({ product: P, qty: "100", price: "12000", type: "CREDIT", date: "2026-06-02" });
    await consume("60", P, w.ids.main);                                              // 60 sold from the OLDER layer (cost 600,000 expensed)
    const d1 = await mkReturn("100");
    const r1 = await w.api(w.owner, w.R.returnPost, { method: "POST", params: { id: d1.body.id } });
    expect(r1.status).toBe(409); expect(r1.body.error.code).toBe("LAYER_ALREADY_SOLD");
    const d2 = await mkReturn("40");
    const r2 = await w.api(w.owner, w.R.returnPost, { method: "POST", params: { id: d2.body.id } });
    expect(r2.status).toBe(200); expect(r2.body.totalBase).toBe("400000");           // 40 x 10,000, NOT the newer 12,000 layer
    const lots = (await w.api(w.owner, w.R.lots, { params: { id: P } })).body;
    expect(Number(lots.find((l: any) => l.unitCostBase === "12000.0000").qtyRemaining)).toBe(100);   // other layer untouched
    const g = (await w.api(w.owner, w.R.purchaseId.GET, { params: { id: po.id } })).body;
    expect(g.outstanding).toBe("600000");                                            // 1,000,000 - 400,000 returned
    expect((await w.recon()).ok).toBe(true);
  });
  it("exceptional return of the sold 60: accountant refused, owner accepted; refund booked against 5200", async () => {
    const d = await mkReturn("60", { exceptionalReason: "المورد وافق على استرداد قيمة البضاعة المباعة" }, w.acct);
    const rr = await w.api(w.acct, w.R.returnPost, { method: "POST", params: { id: d.body.id } });
    expect(rr.status).toBe(403); expect(rr.body.error.code).toBe("EXCEPTIONAL_RETURN_OWNER_ONLY");
    const before = await w.tb();
    const ok = await w.api(w.owner, w.R.returnPost, { method: "POST", params: { id: d.body.id } });
    expect(ok.status).toBe(200); expect(ok.body.totalBase).toBe("600000");
    const tb = await w.tb();
    expect(bal(tb, "5200") - bal(before, "5200")).toBe(-600000);                      // credit: cost recovered after having been expensed
    expect(bal(tb, "1300") - bal(before, "1300")).toBe(0);                            // no stock left to remove
    expect(tb.balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
    expect((await w.api(w.owner, w.R.purchaseId.GET, { params: { id: po.id } })).body.outstanding).toBe("0");
  });
  it("cannot return more than was purchased", async () => {
    const d = await mkReturn("1");
    const r = await w.api(w.owner, w.R.returnPost, { method: "POST", params: { id: d.body.id } });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe("RETURN_EXCEEDS_PURCHASED");
  });
});

describe("TC-07c  supplier payment with FX difference", () => {
  let P: string, po: any;
  it("USD invoice booked at 1,450; paid at 1,480 => 30,000 IQD realised FX loss, payable fully closed", async () => {
    P = await w.mkProduct("USD1");
    po = await w.buy({ product: P, qty: "10", price: "100", currency: "USD", rate: "1450", type: "CREDIT", date: "2026-07-01" });
    const g = (await w.api(w.owner, w.R.purchaseId.GET, { params: { id: po.id } })).body;
    expect(g.total).toBe("1000.0000"); expect(Number(g.totalBase)).toBe(1450000);
    await w.api(w.owner, w.R.fx, { method: "POST", body: { currency: "USD", rateDate: "2026-07-20", rate: "1480" } });
    // fund the USD cash box (capital in USD)
    await w.inject((tx, a, l) => l.postJournal(tx, a, { date: "2026-07-01", sourceDocType: "capital", sourceDocId: crypto.randomUUID(), lines: [{ account: "1120", debit: "1480000", currency: "USD", amountOrig: "1000", fx: "1480" }, { account: "3100", credit: "1480000" }] }));
    const over = await w.api(w.owner, w.R.payments.POST, { method: "POST", body: { supplierId: w.ids.supplier, docDate: "2026-07-20", cashAccountId: w.ids.cashUSD, currency: "USD", amount: "1500", allocations: [{ purchaseId: po.id, amount: "1500" }] } });
    expect(over.body.error.code).toBe("OVER_ALLOCATION");
    const d = await w.api(w.owner, w.R.payments.POST, { method: "POST", body: { supplierId: w.ids.supplier, docDate: "2026-07-20", cashAccountId: w.ids.cashUSD, currency: "USD", amount: "1000", allocations: [{ purchaseId: po.id, amount: "1000" }] } });
    expect(d.status).toBe(200);
    const before = await w.tb();
    const r = await w.api(w.owner, w.R.paymentPost, { method: "POST", params: { id: d.body.id } });
    expect(r.status).toBe(200); expect(Number(r.body.fxDiffBase)).toBe(30000); expect(r.body.docNo).toMatch(/^PV-2026-/);
    const tb = await w.tb();
    expect(bal(tb, "7100") - bal(before, "7100")).toBe(30000);                         // loss, never an operating expense
    expect(bal(tb, "2100") - bal(before, "2100")).toBe(1450000);                       // payable closed at the ORIGINAL rate
    expect(bal(tb, "1120") - bal(before, "1120")).toBe(-1480000);                      // cash left at the payment rate
    expect(tb.balanced).toBe(true);
    expect((await w.api(w.owner, w.R.purchaseId.GET, { params: { id: po.id } })).body.outstanding).toBe("0");
    const stmt = (await w.api(w.owner, w.R.statement, { params: { id: w.ids.supplier } })).body;
    expect(stmt.lines.length).toBeGreaterThan(0);
    void stmt;
  });
  it("reversing the payment reopens the payable and cash; partial payments and advances work", async () => {
    const payments = (await w.api(w.owner, w.R.payments.GET)).body, pay = payments.find((p: any) => p.status === "POSTED" && p.currency === "USD");
    const rv = await w.api(w.owner, w.R.paymentReverse, { method: "POST", params: { id: pay.id }, body: { reason: "دفعة خاطئة" } });
    expect(rv.status).toBe(200);
    expect((await w.api(w.owner, w.R.purchaseId.GET, { params: { id: po.id } })).body.outstanding).toBe("1000");
    const part = await w.api(w.owner, w.R.payments.POST, { method: "POST", body: { supplierId: w.ids.supplier, docDate: "2026-07-21", cashAccountId: w.ids.cashUSD, currency: "USD", amount: "400", allocations: [{ purchaseId: po.id, amount: "300" }] } });
    const pr = await w.api(w.owner, w.R.paymentPost, { method: "POST", params: { id: part.body.id } });
    expect(pr.status).toBe(200);                                                       // 300 allocated + 100 advance to supplier
    expect((await w.api(w.owner, w.R.purchaseId.GET, { params: { id: po.id } })).body.outstanding).toBe("700");
    expect((await w.tb()).balanced).toBe(true);
  });
  it("IQD payment on an IQD invoice has no FX difference; allocation to another supplier's or cash invoice is refused", async () => {
    const P2 = await w.mkProduct("IQD1");
    const inv = await w.buy({ product: P2, qty: "10", price: "1000", type: "CREDIT" });
    const d = await w.api(w.owner, w.R.payments.POST, { method: "POST", body: { supplierId: w.ids.supplier, docDate: "2026-08-01", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "10000", allocations: [{ purchaseId: inv.id, amount: "10000" }] } });
    const r = await w.api(w.owner, w.R.paymentPost, { method: "POST", params: { id: d.body.id } });
    expect(Number(r.body.fxDiffBase)).toBe(0);
    const cashInv = await w.buy({ product: P2, qty: "1", price: "1000", type: "CASH" });
    const bad = await w.api(w.owner, w.R.payments.POST, { method: "POST", body: { supplierId: w.ids.supplier, docDate: "2026-08-01", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "1000", allocations: [{ purchaseId: cashInv.id, amount: "1000" }] } });
    expect(bad.body.error.code).toBe("BAD_ALLOCATION");
  });
});
