import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

/**
 * Price-variable goods whose margin stays OUTSIDE the cash box and outside the partnership.
 * Cost per unit 100,000 in every scenario; prices are test inputs only (nothing is fixed in the system).
 */
let w: World; let P: string; let R: string;
beforeAll(async () => {
  w = await makeWorld(); await w.fund("50000000");
  const r = await w.api(w.acct, w.R.capital.POST, { method: "POST", body: { kind: "INJECTION", docDate: "2026-01-01", cashAccountId: w.ids.cashUSD, currency: "USD", exchangeRate: "1500", amount: "10000", reason: "usd" } });
  await w.api(w.owner, w.R.capitalApprove, { method: "POST", params: { id: r.body.id }, body: {} });
  P = await w.mkProduct("OM"); R = await w.mkProduct("RG");
});
afterAll(async () => { await w.env.teardown(); });
let seq = 0;
const buy = async (prod: string, qty: string, price: string, cls: "USED" | "PARTNERSHIP", date = "2026-01-10") => {
  const po = await w.api(w.owner, w.R.purchases.POST, { method: "POST", body: { supplierId: w.ids.supplier, docDate: date, paymentType: "CASH", cashAccountId: w.ids.cashIQD, currency: "IQD", lines: [{ productId: prod, uom: "قطعة", qty, unitPrice: price, profitClass: cls }] } });
  expect((await w.api(w.owner, w.R.purchasePost, { method: "POST", params: { id: po.body.id } })).status).toBe(200); return po.body.id as string;
};
const sell = async (lines: { prod: string; qty: string; price: string; cls: "USED" | "PARTNERSHIP" }[], o: { discount?: string; currency?: string; rate?: string; date?: string } = {}) => {
  const inv = await w.api(w.owner, w.R.invoices.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: o.date ?? "2026-02-01", saleType: "CREDIT", currency: o.currency ?? "IQD", exchangeRate: o.rate, discount: o.discount ?? "0", lines: lines.map((l) => ({ productId: l.prod, uom: "قطعة", qty: l.qty, unitPrice: l.price, profitClass: l.cls })) } });
  expect((await w.api(w.owner, w.R.invoicePost, { method: "POST", params: { id: inv.body.id } })).status, JSON.stringify(inv.body)).toBe(200); return inv.body.id as string;
};
const collect = (inv: string, b: Record<string, unknown>) => w.api(w.owner, w.R.collect, { method: "POST", params: { id: inv }, body: { requestId: "om-" + (++seq) + "-" + Math.random().toString(36).slice(2), docDate: "2026-02-10", cashAccountId: w.ids.cashIQD, currency: "IQD", ...b } });
const iqdCash = async () => Number((await w.api(w.owner, w.R.cash)).body.find((c: any) => c.kind === "MAIN_CASH" && c.currency === "IQD").balance);
const acct = async (c: string) => bal(await w.tb(), c);
const prev = async () => (await w.api(w.owner, w.R.settlePreview, { method: "POST", body: { periodStart: "2026-01-01", periodEnd: "2026-12-31" } })).body;

describe("acceptance cases (cost 100,000, delivered, customer pays the sale price)", () => {
  it("case 1: price 150,000 -> 100,000 into the box, 50,000 outside, partnership profit 0, no partner share", async () => {
    await buy(P, "1", "100000", "USED"); const inv = await sell([{ prod: P, qty: "1", price: "150000", cls: "USED" }]);
    const before = await iqdCash();
    const r = await collect(inv, { amount: "100000", outsideAmount: "50000" }); expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await iqdCash()).toBe(before + 100000);                                                       // only the cost entered the box
    const g = await w.getInvoice(inv); expect(g).toMatchObject({ outstanding: "0" }); expect(Number(g.collected)).toBe(100000); expect(Number(g.outside)).toBe(50000);
    expect(await acct("3600")).toBe(50000); expect(await acct("1200")).toBe(0); expect(await acct("3500")).toBe(0);
    expect(Number(g.profit.usedProfitBase)).toBe(50000); expect(Number(g.profit.linkedProfitBase)).toBe(0);   // the margin is real trade profit, but not partnership profit
    expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
    expect((await w.env.admin`SELECT count(*)::int n FROM profit_settlement_shares`)[0]!.n).toBe(0);
  });
  it("case 2: price 130,000 -> 100,000 in, 30,000 outside, partnership profit 0", async () => {
    await buy(P, "1", "100000", "USED"); const inv = await sell([{ prod: P, qty: "1", price: "130000", cls: "USED" }]);
    expect((await collect(inv, { amount: "100000", outsideAmount: "30000" })).status).toBe(200);
    expect(await acct("3600")).toBe(80000); expect(Number((await w.getInvoice(inv)).profit.linkedProfitBase)).toBe(0);
  });
  it("case 3: price 100,000 -> 100,000 in, nothing outside, profit 0", async () => {
    await buy(P, "1", "100000", "USED"); const inv = await sell([{ prod: P, qty: "1", price: "100000", cls: "USED" }]);
    expect((await collect(inv, { amount: "100000" })).status).toBe(200); expect(await acct("3600")).toBe(80000);
    expect((await collect(inv, { amount: "1" })).body.error.code).toBe("ALREADY_SETTLED");
  });
  it("case 4: price 90,000 -> 90,000 in, a 10,000 LOSS, no cost refund, no negative outside, no phantom cash", async () => {
    await buy(P, "1", "100000", "USED"); const inv = await sell([{ prod: P, qty: "1", price: "90000", cls: "USED" }]);
    const before = await iqdCash();
    expect((await collect(inv, { amount: "50000", outsideAmount: "40000" })).body.error.code).toBe("OUTSIDE_EXCEEDS_MARGIN");   // there is no margin: nothing may be recorded outside
    expect((await collect(inv, { amount: "90000" })).status).toBe(200); expect(await iqdCash()).toBe(before + 90000);
    expect(await acct("3600")).toBe(80000);
    const g = await w.getInvoice(inv); expect(Number(g.profit.usedProfitBase)).toBe(-10000);
    expect((await w.tb()).balanced).toBe(true);
  });
});

describe("13 pieces bought for 1,300,000 and sold at different prices: results come from actual prices and FIFO costs", () => {
  it("sums actual margins (including a loss) and the cash that really entered the box", async () => {
    const P13 = await w.mkProduct("OM13"); await buy(P13, "13", "100000", "USED", "2026-03-01");
    const out0 = await acct("3600"), cash0 = await iqdCash();
    const plan = [{ qty: "5", price: "140000", outside: "200000" }, { qty: "3", price: "100000", outside: "0" }, { qty: "3", price: "95000", outside: "0" }, { qty: "2", price: "160000", outside: "120000" }];
    let sales = 0, margin = 0;
    for (const p of plan) {
      const inv = await sell([{ prod: P13, qty: p.qty, price: p.price, cls: "USED" }], { date: "2026-03-05" });
      const total = Number(p.qty) * Number(p.price); sales += total; margin += total - Number(p.qty) * 100000;
      const r = await collect(inv, { amount: String(total - Number(p.outside)), outsideAmount: p.outside }); expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await w.getInvoice(inv)).outstanding).toBe("0");
    }
    expect(sales).toBe(1605000); expect(margin).toBe(305000);                                              // 200,000 + 0 - 15,000 + 120,000
    expect(await acct("3600") - out0).toBe(320000);                                                        // only the two profitable invoices left money outside
    expect(await iqdCash() - cash0).toBe(1285000);                                                         // box received 1,285,000 = cost 1,300,000 - the 15,000 loss
    const pnl = (await w.api(w.owner, w.R.report2, { params: { id: "profit-loss" }, path: "/api/reports2/profit-loss?from=2026-03-01&to=2026-03-31" } as any)).body;
    expect(Number(pnl.rows.find((x: any) => x.label === "= الربح التجاري (الإجمالي)").amount)).toBe(305000);   // trade profit stays visible in activity reports
    expect((await prev()).eligibleProfit).toBe("0");                                                       // ...but none of it is partnership profit
  });
});

describe("partial collection, discounts, returns, mixed invoices, USD, retries", () => {
  it("partial: what was paid, what entered the box and what was received outside are recorded; the rest stays receivable", async () => {
    await buy(P, "1", "100000", "USED"); const inv = await sell([{ prod: P, qty: "1", price: "150000", cls: "USED" }]);
    expect((await collect(inv, { amount: "60000" })).status).toBe(200);
    let g = await w.getInvoice(inv); expect(g.outstanding).toBe("90000"); expect(Number(g.outside)).toBe(0);              // nothing auto-moved to "outside"
    expect((await collect(inv, { amount: "30000", outsideAmount: "50002" })).body.error.code).toBe("OUTSIDE_EXCEEDS_MARGIN");   // more than the margin earned
    expect((await collect(inv, { amount: "0", outsideAmount: "20000" })).status).toBe(200);                              // a pure outside receipt is allowed (amount 0)
    g = await w.getInvoice(inv); expect(g.outstanding).toBe("70000"); expect(Number(g.outside)).toBe(20000);
    expect((await collect(inv, { amount: "40000", outsideAmount: "30000" })).status).toBe(200);
    g = await w.getInvoice(inv); expect(g.outstanding).toBe("0"); expect(Number(g.collected)).toBe(100000); expect(Number(g.outside)).toBe(50000);
    expect((await w.tb()).balanced).toBe(true);
  });
  it("an invoice-level discount reduces the margin: net 280,000 on cost 200,000 allows at most 80,000 outside", async () => {
    await buy(P, "2", "100000", "USED"); const inv = await sell([{ prod: P, qty: "2", price: "150000", cls: "USED" }], { discount: "20000" });
    expect((await collect(inv, { amount: "199000", outsideAmount: "81000" })).body.error.code).toBe("OUTSIDE_EXCEEDS_MARGIN");
    expect((await collect(inv, { amount: "200000", outsideAmount: "80000" })).status).toBe(200); expect((await w.getInvoice(inv)).outstanding).toBe("0");
  });
  it("mixed invoice: only the excluded line's margin is excluded; the regular line stays distributable", async () => {
    await buy(P, "1", "100000", "USED"); await buy(R, "1", "80000", "PARTNERSHIP");
    const inv = await sell([{ prod: P, qty: "1", price: "150000", cls: "USED" }, { prod: R, qty: "1", price: "120000", cls: "PARTNERSHIP" }]);
    expect((await collect(inv, { amount: "220000", outsideAmount: "50000" })).status).toBe(200);
    const g = await w.getInvoice(inv); expect(g.outstanding).toBe("0"); expect(Number(g.profit.linkedProfitBase)).toBe(40000); expect(Number(g.profit.usedProfitBase)).toBe(50000);
    const pv = await prev(); expect(pv.lines.find((l: any) => l.invoiceId === inv).newly).toBe("40000");   // not the whole invoice
  });
  it("a return after collection restores the stock at its original cost and posts no history rewrite", async () => {
    await buy(P, "1", "100000", "USED"); const inv = await sell([{ prod: P, qty: "1", price: "150000", cls: "USED" }]); await collect(inv, { amount: "100000", outsideAmount: "50000" });
    const g = await w.getInvoice(inv); const o3600 = await acct("3600");
    const rd = await w.api(w.owner, w.R.sreturns.POST, { method: "POST", body: { invoiceId: inv, docDate: "2026-02-20", reason: "إرجاع", settlement: "REDUCE_RECEIVABLE", lines: [{ salesLineId: g.lines[0].id, qtyBase: "1" }] } });
    const rp = await w.api(w.owner, w.R.sreturnPost, { method: "POST", params: { id: rd.body.id } }); expect(rp.status, JSON.stringify(rp.body)).toBe(200);
    expect(Number(rp.body.cogsBase)).toBe(100000); expect(Number(rp.body.customerCredit)).toBe(150000);       // the customer is owed credit for what he paid (cash + outside)
    expect(await acct("3600")).toBe(o3600);                                                                   // the earlier outside receipt is history, untouched
    expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
  });
  it("USD invoice: the margin outside is in USD at the invoice rate; the box receives the cost in USD", async () => {
    await buy(P, "1", "100000", "USED"); const inv = await sell([{ prod: P, qty: "1", price: "100", cls: "USED" }], { currency: "USD", rate: "1500" });      // 100 USD = 150,000 IQD
    const r = await collect(inv, { amount: "66.67", currency: "USD", cashAccountId: w.ids.cashUSD, exchangeRate: "1500", outsideAmount: "33.33" }); expect(r.status, JSON.stringify(r.body)).toBe(200);
    const g = await w.getInvoice(inv); expect(g.outstanding).toBe("0"); expect((await w.tb()).balanced).toBe(true);
    const usd = (await w.api(w.owner, w.R.cash)).body.find((c: any) => c.kind === "MAIN_CASH" && c.currency === "USD"); expect(Number(usd.balance)).toBe(10000 + 66.67);
  });
  it("a double click / retry with the same request key creates ONE receipt and moves cash once", async () => {
    await buy(P, "1", "100000", "USED"); const inv = await sell([{ prod: P, qty: "1", price: "150000", cls: "USED" }]); const before = await iqdCash();
    const body = { requestId: "om-retry-0001", docDate: "2026-02-10", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "100000", outsideAmount: "50000" };
    const [a, b] = await Promise.all([w.api(w.owner, w.R.collect, { method: "POST", params: { id: inv }, body }), w.api(w.owner, w.R.collect, { method: "POST", params: { id: inv }, body })]);
    expect(a.status).toBe(200); expect(b.status).toBe(200); expect(a.body.receiptId).toBe(b.body.receiptId); expect(await iqdCash()).toBe(before + 100000);
  });
  it("editing the receipt later keeps the split coherent: outside part is bounded again and the cash reverses once", async () => {
    await buy(P, "1", "100000", "USED"); const inv = await sell([{ prod: P, qty: "1", price: "150000", cls: "USED" }]);
    const r = await collect(inv, { amount: "100000", outsideAmount: "50000" }); const rid = r.body.receiptId; const base = await iqdCash();
    const ed = (await w.api(w.owner, w.R.receiptEdit, { params: { id: rid } })).body;
    const a = await w.api(w.owner, w.R.receiptAmend, { method: "POST", params: { id: rid }, body: { customerId: w.ids.customer, docDate: "2026-02-10", cashAccountId: w.ids.cashIQD, currency: "IQD", amount: "80000", allocations: [{ invoiceId: inv, amount: "80000", externalAmount: "50000", externalKind: "OUTSIDE_MARGIN" }], version: ed.version } });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const g = await w.getInvoice(inv); expect(g.outstanding).toBe("20000"); expect(Number(g.outside)).toBe(50000); expect(await iqdCash()).toBe(base - 20000);
    expect((await w.tb()).balanced).toBe(true);
  });
});

describe("reports: batches and their sales, linked through real lots, lines and receipts", () => {
  const rep = async (id: string, q = "") => (await w.api(w.owner, w.R.report2, { params: { id }, path: `/api/reports2/${id}${q}` } as any)).body;
  it("sales report: customer, invoice, supplier + purchase invoice, real price, cost, profit, paid / remaining / box / outside — per invoice figures counted once", async () => {
    const r = await rep("outside-sales"); expect(r.rows.length).toBeGreaterThan(5);
    const one = r.rows.find((x: any) => Number(x.unitPrice) === 150000 && Number(x.outside) === 50000 && Number(x.box) === 100000);
    expect(one).toMatchObject({ supplier: expect.any(String), purchaseNo: expect.stringMatching(/^PO-/), invoiceNo: expect.stringMatching(/^INV-/) }); expect(one.invoiceLink).toMatch(/^\/sales\//); expect(one.purchaseLink).toMatch(/^\/purchases\//);
    expect(Number(one.cost)).toBe(100000); expect(Number(one.profit)).toBe(50000);
    const t = r.totals.find((x: any) => x.currency === "IQD");
    const sumDistinct = new Map<string, number>(); for (const x of r.rows.filter((y: any) => y.currency === "IQD")) sumDistinct.set(x.invoiceNo, Number(x.outside));
    expect(Number(t.outside)).toBe([...sumDistinct.values()].reduce((a, b) => a + b, 0));              // invoice-level outside counted once per invoice, not once per row
    expect(Number(t.profit)).toBe(r.rows.filter((y: any) => y.currency === "IQD").reduce((a: number, y: any) => a + Number(y.profit), 0));
  });
  it("batches report: purchased, sold, returned, remaining and where the rest is, for each purchase line; classification survives a transfer to partner custody", async () => {
    const PT = await w.mkProduct("OMT"); const po = await buy(PT, "10", "100000", "USED", "2026-05-01");
    const t = await w.api(w.owner, w.R.transfers.POST, { method: "POST", body: { docDate: "2026-05-02", fromLocationId: w.ids.main, toLocationId: w.ids.partner, lines: [{ productId: PT, uom: "قطعة", qty: "6" }] } });
    expect((await w.api(w.owner, w.R.transferPost, { method: "POST", params: { id: t.body.id } })).status).toBe(200);
    const inv = await sell([{ prod: PT, qty: "4", price: "130000", cls: "USED" }], { date: "2026-05-03" });                  // FIFO takes from the oldest layers: 4 of the 4 left in main
    const g = await w.getInvoice(inv); const rd = await w.api(w.owner, w.R.sreturns.POST, { method: "POST", body: { invoiceId: inv, docDate: "2026-05-04", reason: "إرجاع جزئي", settlement: "REDUCE_RECEIVABLE", lines: [{ salesLineId: g.lines[0].id, qtyBase: "1" }] } });
    const rpost = await w.api(w.owner, w.R.sreturnPost, { method: "POST", params: { id: rd.body.id } }); expect(rpost.status, JSON.stringify([rd.body, rpost.body])).toBe(200);
    const r = await rep("outside-batches", "?from=2026-05-01&to=2026-05-31"); expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ poLink: `/purchases/${po}` }); expect(Number(r.rows[0].qty)).toBe(10); expect(Number(r.rows[0].sold)).toBe(4); expect(Number(r.rows[0].returned)).toBe(1); expect(Number(r.rows[0].remaining)).toBe(7);
    expect(r.rows[0].locs).toContain("عهدة الشريك");
    expect((await w.env.admin`SELECT count(*)::int n FROM stock_lots l JOIN stock_lots s ON s.id = l.source_lot_id WHERE l.profit_class <> s.profit_class`)[0]!.n).toBe(0);
  });
  it("screen = Excel: same rows, same figures, per-currency totals, dinar columns without decimals even beside a dollar invoice", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const screen = await rep("outside-sales");
    const res: any = await w.api(w.owner, w.R.exportReport, { params: { id: "outside-sales" }, path: "/api/export-report/outside-sales" } as any); expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(res.buffer as any); const ws = wb.worksheets[0]!;
    const header = (ws.getRow(1).values as any[]).slice(1); const idxCost = header.indexOf("الكلفة الفعلية (IQD)") + 1, idxNo = header.indexOf("فاتورة البيع") + 1;
    const body: any[] = []; ws.eachRow((row, n) => { if (n > 1 && row.getCell(idxNo).value && String(row.getCell(idxNo).value).startsWith("INV-")) body.push(row); });
    expect(body.length).toBe(screen.rows.length);
    for (const [i, row] of body.entries()) expect(Number(row.getCell(idxCost).value)).toBe(Number(screen.rows[i].cost));
    const usdRow = body.find((row) => row.getCell(header.indexOf("العملة") + 1).value === "USD"); if (usdRow) expect(usdRow.getCell(idxCost).numFmt).toBe("#,##0;[Red]-#,##0");
    const totals: string[] = []; ws.eachRow((row) => { const v = String(row.getCell(1).value ?? ""); if (v.startsWith("الإجمالي")) totals.push(v); }); expect(totals.length).toBe(screen.totals.length);
  });
});
