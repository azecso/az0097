import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, capital, type World } from "./world";

let w: World;
beforeAll(async () => { w = await makeWorld(); await capital(w, "100000000"); });
afterAll(async () => { await w.env.teardown(); });

describe("stock concurrency", () => {
  it("6 simultaneous transfers of 3 units from a stock of 10: exactly 3 succeed, stock never negative, books reconcile", async () => {
    const P = await w.mkProduct("CONC");
    await w.buy({ product: P, qty: "10", price: "1000" });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await w.api(w.owner, w.R.transfers.POST, { method: "POST", body: { docDate: "2026-09-01", fromLocationId: w.ids.main, toLocationId: w.ids.partner, lines: [{ productId: P, uom: "قطعة", qty: "3" }] } })).body.id);
    const res = await Promise.all(ids.map((id) => w.api(w.owner, w.R.transferPost, { method: "POST", params: { id } })));
    const ok = res.filter((r) => r.status === 200).length, short = res.filter((r) => r.status === 409 && r.body.error.code === "INSUFFICIENT_STOCK").length;
    expect(ok).toBe(3); expect(short).toBe(3);
    const stock = (await w.api(w.owner, w.R.stock)).body.filter((s: any) => s.productId === P);
    expect(stock.map((s: any) => `${s.warehouseKind}:${Number(s.qty)}`).sort()).toEqual(["MAIN:1", "PARTNER_CUSTODY:9"]);
    expect((await w.recon()).ok).toBe(true); expect((await w.tb()).balanced).toBe(true);
    const nos = res.filter((r) => r.status === 200).map((r) => r.body.docNo).sort();
    expect(new Set(nos).size).toBe(3);                                               // unique numbers, rolled-back attempts consumed none
  });
  it("simultaneous posting of different purchases yields unique, gapless numbers", async () => {
    const P = await w.mkProduct("NUM");
    const drafts = [];
    for (let i = 0; i < 8; i++) drafts.push((await w.api(w.owner, w.R.purchases.POST, { method: "POST", body: { supplierId: w.ids.supplier, docDate: "2026-09-02", paymentType: "CREDIT", currency: "IQD", lines: [{ productId: P, uom: "قطعة", qty: "1", unitPrice: "10" }] } })).body.id);
    const res = await Promise.all(drafts.map((id) => w.api(w.owner, w.R.purchasePost, { method: "POST", params: { id } })));
    expect(res.every((r) => r.status === 200)).toBe(true);
    const nums = res.map((r) => Number(r.body.docNo.split("-")[2])).sort((a, b) => a - b);
    expect(nums[nums.length - 1]! - nums[0]!).toBe(7);                               // consecutive
  });
});

describe("property: random operations never break the ledger or the FIFO layers", () => {
  it("60 random purchases/transfers/consumptions/counts keep sub-ledger == ledger, balance, no negatives", async () => {
    let seed = 12345; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const prods = [await w.mkProduct("PR1"), await w.mkProduct("PR2", { qtyDecimals: 2 })];
    const log: string[] = [];
    for (let i = 0; i < 60; i++) {
      const P = prods[rnd(2)]!, op = rnd(5), q = (1 + rnd(9)).toString();
      if (op <= 1) log.push("buy:" + (await w.buy({ product: P, qty: q, price: String(100 * (1 + rnd(50))), date: `2026-10-${String(1 + rnd(28)).padStart(2, "0")}`, type: rnd(2) ? "CASH" : "CREDIT" })).status);
      else if (op === 2) { const [from, to] = rnd(2) ? [w.ids.main, w.ids.partner] : [w.ids.partner, w.ids.main];
        const d = await w.api(w.owner, w.R.transfers.POST, { method: "POST", body: { docDate: "2026-10-15", fromLocationId: from, toLocationId: to, lines: [{ productId: P, uom: "قطعة", qty: q }] } });
        log.push("tr:" + (await w.api(w.owner, w.R.transferPost, { method: "POST", params: { id: d.body.id } })).status); }
      else if (op === 3) { try { await w.inject(async (tx, a, l) => { const out = await l.consumeFifo(tx, a.companyId, { productId: P, locationId: rnd(2) ? w.ids.main : w.ids.partner, qtyBase: q, type: "SALE_OUT", docType: "t", docId: crypto.randomUUID(), docLineId: crypto.randomUUID(), at: new Date() });
          await l.postJournal(tx, a, { date: "2026-10-20", sourceDocType: "t", sourceDocId: crypto.randomUUID(), lines: [{ account: "5100", debit: out.cost }, { account: "1300", credit: out.cost }] }); }); log.push("sale:ok"); } catch { log.push("sale:short"); } }
      else { const d = await w.api(w.owner, w.R.counts.POST, { method: "POST", body: { docDate: "2026-10-25", locationId: w.ids.main, reason: "جرد", lines: [{ productId: P, countedQtyBase: String(rnd(15)), unitCostBase: "500" }] } });
        log.push("cnt:" + (await w.api(w.owner, w.R.countPost, { method: "POST", params: { id: d.body.id } })).status); }
      if (i % 10 === 9) { const r = await w.recon(), t = await w.tb(); expect(r.ok, `recon after ${i}: ${JSON.stringify(r)}`).toBe(true); expect(t.balanced).toBe(true); }
    }
    const neg = await w.env.admin`SELECT count(*)::int n FROM stock_lots WHERE qty_remaining < 0 OR cost_remaining_base < 0`;
    expect(neg[0]!.n).toBe(0);
    expect(log.filter((x) => x.endsWith(":200")).length).toBeGreaterThan(10);        // the run actually exercised posting
    const sums = await w.env.admin`SELECT (SELECT coalesce(sum(cost_remaining_base),0) FROM stock_lots)::text AS lots, (SELECT coalesce(sum(debit_base-credit_base),0) FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE a.code IN ('1300','1310'))::text AS gl`;
    expect(sums[0]!.lots).toBe(sums[0]!.gl);
  });
});
