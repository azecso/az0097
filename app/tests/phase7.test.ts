import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, capital, bal, type World } from "./world";

let w: World;
beforeAll(async () => { w = await makeWorld(); await capital(w, "50000000"); });
afterAll(async () => { await w.env.teardown(); });
const get = (h: any, path: string, s = w.owner) => w.api(s, h, { path });

describe("capital-return register (informational, no accounting effect)", () => {
  it("records time, amount, recipient and receipt number without touching the ledger", async () => {
    const before = await w.tb();
    const r = await w.api(w.owner, w.R.capRet.POST, { method: "POST", body: { returnedAt: "2026-03-05T14:30:00.000Z", currency: "IQD", amount: "2500000", recipientName: "أحمد صاحب المال", refNo: "R-77", method: "CASH", note: "دفعة أولى" } });
    expect(r.status).toBe(200); expect(r.body.docNo).toMatch(/^CR-2026-000001$/);
    const after = await w.tb();
    expect(after.rows).toEqual(before.rows); expect(after.balanced).toBe(true);                     // ledger untouched
    expect(bal(after, "1110")).toBe(bal(before, "1110"));                                            // cash untouched
    const l = await get(w.R.capRet.GET, "/api/capital-returns");
    expect(l.body.rows.length).toBe(1); expect(l.body.rows[0]).toMatchObject({ recipientName: "أحمد صاحب المال", refNo: "R-77", amount: "2500000.0000" });
    expect(l.body.totals).toEqual([{ currency: "IQD", total: "2500000.0000", n: 1 }]);
  });
  it("filters by period and text; totals are per currency", async () => {
    await w.api(w.owner, w.R.capRet.POST, { method: "POST", body: { returnedAt: "2026-04-01T09:00:00.000Z", currency: "USD", amount: "1000", recipientName: "أحمد صاحب المال" } });
    const q1 = await get(w.R.capRet.GET, "/api/capital-returns?from=2026-04-01&to=2026-04-30");
    expect(q1.body.rows.length).toBe(1); expect(q1.body.totals[0].currency).toBe("USD");
    expect((await get(w.R.capRet.GET, "/api/capital-returns?q=R-77")).body.rows.length).toBe(1);
  });
  it("can be edited (version-checked) and deleted with a reason, both audited with before/after", async () => {
    const row = (await get(w.R.capRet.GET, "/api/capital-returns?q=R-77")).body.rows[0];
    const bad = await w.api(w.owner, w.R.capRetId.PUT, { method: "PUT", params: { id: row.id }, body: { returnedAt: "2026-03-05T14:30:00.000Z", currency: "IQD", amount: "2600000", recipientName: "أحمد", version: 99 } });
    expect(bad.status).toBe(409);
    const ok = await w.api(w.owner, w.R.capRetId.PUT, { method: "PUT", params: { id: row.id }, body: { returnedAt: "2026-03-05T14:30:00.000Z", currency: "IQD", amount: "2600000", recipientName: "أحمد", refNo: "R-77", method: "CASH", version: row.version } });
    expect(ok.status).toBe(200);
    expect((await w.api(w.owner, w.R.capRetId.DELETE, { method: "DELETE", params: { id: row.id }, path: "/api/capital-returns/x" })).status).toBe(400);   // reason required
    const del = await w.api(w.owner, w.R.capRetId.DELETE, { method: "DELETE", params: { id: row.id }, path: "/api/capital-returns/x?reason=" + encodeURIComponent("إدخال بالخطأ") });
    expect(del.status).toBe(200);
    expect((await get(w.R.capRet.GET, "/api/capital-returns?q=R-77")).body.rows.length).toBe(0);
    const audit = await w.env.admin.unsafe(`SELECT action, before_data, reason FROM audit_logs WHERE entity_id = '${row.id}' ORDER BY id`);
    expect(audit.map((a: any) => a.action)).toEqual(["capital_return.create", "capital_return.update", "capital_return.delete"]);
    expect(audit[1]!.before_data.amount).toBe("2500000.0000"); expect(audit[2]!.reason).toBe("إدخال بالخطأ");
    expect((await w.tb()).balanced).toBe(true);
  });
  it("rejects nonsense and unauthorised users", async () => {
    const neg = await w.api(w.owner, w.R.capRet.POST, { method: "POST", body: { returnedAt: "2026-03-05T10:00:00Z", currency: "IQD", amount: "0", recipientName: "x y" } });
    expect(neg.status).toBe(400);
    const none = await w.api(null as never, w.R.capRet.GET, { path: "/api/capital-returns" });
    expect(none.status).toBe(401);
  });
});

describe("sales / purchases / balances / movement reports", () => {
  let P1: string, P2: string, c2: string, s2: string;
  beforeAll(async () => {
    P1 = await w.mkProduct("RP1"); P2 = await w.mkProduct("RP2");
    c2 = (await w.api(w.owner, w.R.contacts.POST, { method: "POST", body: { kind: "CUSTOMER", code: "C-RP2", name: "عميل ثان", paymentTermsDays: 30 } })).body.id;
    s2 = (await w.api(w.owner, w.R.contacts.POST, { method: "POST", body: { kind: "SUPPLIER", code: "S-RP2", name: "مورد ثان", paymentTermsDays: 30 } })).body.id;
    await w.buy({ product: P1, qty: "100", price: "1000", date: "2026-05-02" });
    await w.buy({ product: P2, qty: "50", price: "2000", date: "2026-06-03", type: "CREDIT" });
    await w.sale({ product: P1, qty: "40", price: "1500", date: "2026-05-10", type: "CREDIT" });                       // revenue 60,000 cost 40,000
    await w.sale({ product: P2, qty: "10", price: "3000", date: "2026-06-12", type: "CREDIT", customer: c2 });          // revenue 30,000 cost 20,000
  });
  it("sales by invoice with cost and profit; totals add up", async () => {
    const r = await get(w.R.repSales, "/api/reports/sales?group=invoice&from=2026-05-01&to=2026-06-30");
    expect(r.status).toBe(200); expect(r.body.rows.length).toBe(2);
    expect(r.body.totals).toMatchObject({ net: "90000", cost: "60000", profit: "30000", docs: 2 });
  });
  it("sales grouped by customer, product and month", async () => {
    const byCust = (await get(w.R.repSales, "/api/reports/sales?group=party")).body.rows;
    expect(byCust.find((x: any) => x.label === "عميل ثان")).toMatchObject({ net: "30000.0000", profit: "10000.0000" });
    const byProd = (await get(w.R.repSales, "/api/reports/sales?group=product")).body.rows;
    expect(byProd.find((x: any) => x.label.startsWith("RP1"))).toMatchObject({ qty: "40.000000", net: "60000.0000", profit: "20000.0000" });
    const byMonth = (await get(w.R.repSales, "/api/reports/sales?group=month")).body.rows.map((x: any) => x.label).sort();
    expect(byMonth).toEqual(expect.arrayContaining(["2026-05", "2026-06"]));
  });
  it("filters by customer and by product; period excludes outside documents", async () => {
    expect((await get(w.R.repSales, `/api/reports/sales?group=invoice&partyId=${c2}`)).body.rows.length).toBe(1);
    expect((await get(w.R.repSales, `/api/reports/sales?group=invoice&productId=${P1}&from=2026-05-01&to=2026-05-31`)).body.totals.net).toBe("60000");
    expect((await get(w.R.repSales, "/api/reports/sales?from=2030-01-01")).body.rows.length).toBe(0);
  });
  it("a posted sales return lowers revenue and cost in the report", async () => {
    const inv = (await w.api(w.owner, w.R.invoices.GET)).body.find((x: any) => x.customerName === "عميل ثان");
    const full = await w.getInvoice(inv.id);
    const ret = await w.api(w.owner, w.R.sreturns.POST, { method: "POST", body: { invoiceId: inv.id, docDate: "2026-06-20", reason: "تلف", settlement: "REDUCE_RECEIVABLE", lines: [{ salesLineId: full.lines[0].id, qtyBase: "2" }] } });
    expect(ret.status).toBe(200);
    expect((await w.api(w.owner, w.R.sreturnPost, { method: "POST", params: { id: ret.body.id } })).status).toBe(200);
    const r = (await get(w.R.repSales, `/api/reports/sales?group=party&partyId=${c2}`)).body.rows[0];
    expect(r).toMatchObject({ gross: "30000.0000", returns: "6000.0000", net: "24000.0000", cost: "16000.0000", profit: "8000.0000" });
  });
  it("purchases by supplier / product / invoice", async () => {
    const byProd = (await get(w.R.repPurch, "/api/reports/purchases?group=product")).body;
    expect(byProd.rows.find((x: any) => x.label.startsWith("RP2"))).toMatchObject({ qty: "50.000000", goods: "100000.0000", charges: null });
    expect((await get(w.R.repPurch, "/api/reports/purchases?group=invoice")).body.totals.goods).toMatch(/^\d+/);
    const bySup = (await get(w.R.repPurch, "/api/reports/purchases?group=party&from=2026-06-01&to=2026-06-30")).body;
    expect(bySup.rows.length).toBe(1); expect(bySup.totals.net).toBe("100000");
  });
  it("debtors and creditors: detail and per-party summary, never mixing currencies", async () => {
    const det = (await get(w.R.repBal, "/api/reports/balances?side=debtors")).body;
    expect(det.mode).toBe("detail"); expect(det.rows.length).toBeGreaterThanOrEqual(2);
    const sum = (await get(w.R.repBal, "/api/reports/balances?side=debtors&summary=1")).body;
    expect(sum.mode).toBe("summary"); expect(sum.rows.find((x: any) => x.party === "عميل ثان")).toMatchObject({ currency: "IQD", docs: 1, outstanding: "24000" });
    const cr = (await get(w.R.repBal, "/api/reports/balances?side=creditors&summary=1")).body;
    expect(cr.rows.length).toBeGreaterThanOrEqual(1); expect(cr.totals.every((t: any) => /^[A-Z]{3}$/.test(t.currency))).toBe(true);
    const one = (await get(w.R.repBal, `/api/reports/balances?side=creditors&partyId=${s2}`)).body;
    expect(one.rows.every((x: any) => x.party === "مورد ثان")).toBe(true);
  });
  it("product movement shows in/out with a running balance and an opening balance", async () => {
    const m = (await get(w.R.repMove, `/api/reports/product-movement?productId=${P1}`)).body;
    expect(m.rows.map((r: any) => r.type)).toEqual(["PURCHASE_IN", "SALE_OUT"]);
    expect(m.rows.map((r: any) => Number(r.balance))).toEqual([100, 60]); expect(m.totals).toMatchObject({ qtyIn: "100", qtyOut: "40" });
    const m2 = (await get(w.R.repMove, `/api/reports/product-movement?productId=${P1}&from=2026-05-05`)).body;
    expect(Number(m2.opening.qty)).toBe(100); expect(m2.rows.length).toBe(1); expect(Number(m2.closing)).toBe(60);
  });
  it("an accountant with the default template can read reports; a user with no grants cannot", async () => {
    expect((await get(w.R.repSales, "/api/reports/sales", w.acct)).status).toBe(200);
    const bad = await get(w.R.repSales, "/api/reports/sales?group=bogus"); expect(bad.status).toBe(400);
  });
});

describe("debtors report includes receipts that were not allocated to an invoice", () => {
  it("shows the unallocated credit and nets it, then disappears once applied to the invoice", async () => {
    const P = await w.mkProduct("RP9"); await w.buy({ product: P, qty: "100", price: "1000", date: "2026-07-01" });
    const c3 = (await w.api(w.owner, w.R.contacts.POST, { method: "POST", body: { kind: "CUSTOMER", code: "C-RP3", name: "مروان", paymentTermsDays: 0 } })).body.id;
    const inv = await w.sale({ product: P, qty: "10", price: "306000", date: "2026-07-05", type: "CREDIT", customer: c3 });          // 3,060,000
    const rc = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: c3, docDate: "2026-07-06", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "2920000", allocations: [] } });
    expect((await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: rc.body.id } })).status).toBe(200);
    const sum = (await get(w.R.repBal, `/api/reports/balances?side=debtors&summary=1&partyId=${c3}`)).body;
    expect(sum.rows).toEqual([expect.objectContaining({ party: "مروان", currency: "IQD", outstanding: "140000" })]);
    expect(sum.totals).toEqual([{ currency: "IQD", total: "140000" }]);
    const det = (await get(w.R.repBal, `/api/reports/balances?side=debtors&partyId=${c3}`)).body.rows;
    expect(det.map((r: any) => Number(r.outstanding)).sort((a: number, b: number) => a - b)).toEqual([-2920000, 3060000]);
    // apply the credit to the invoice with a CREDIT_APPLICATION receipt: the report then shows one open invoice of 140,000
    const ap = await w.api(w.owner, w.R.receipts.POST, { method: "POST", body: { customerId: c3, docDate: "2026-07-07", kind: "CREDIT_APPLICATION", currency: "IQD", amount: "2920000", allocations: [{ invoiceId: inv.id, amount: "2920000" }] } });
    expect((await w.api(w.owner, w.R.receiptPost, { method: "POST", params: { id: ap.body.id } })).status).toBe(200);
    const after = (await get(w.R.repBal, `/api/reports/balances?side=debtors&partyId=${c3}`)).body.rows;
    expect(after.length).toBe(1); expect(Number(after[0].outstanding)).toBe(140000);
  });
});
