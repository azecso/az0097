import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("20000000"); P = await w.mkProduct("RF"); await w.buy({ product: P, qty: "50", price: "800", date: "2026-02-01" }); });
afterAll(async () => { await w.env.teardown(); });
const cashNet = async (acct: string) => Number((await w.env.admin`SELECT COALESCE(sum(amount),0)::text AS s FROM cash_movements WHERE cash_account_id = ${acct}`)[0]!.s);
const refund = async (b: Record<string, unknown>) => w.api(w.owner, (await import("@/app/api/customer-refunds/route")).POST, { method: "POST", body: { requestId: `rf-${Math.random().toString(36).slice(2)}-xx`, docDate: "2026-06-01", reason: "ردّ رصيد", ...b } });

describe("refund of customer credit", () => {
  it("cancel an invoice keeping the cash as credit, then refund it: cash leaves the box, credit drops, books balance; over-refund refused; idempotent; reversible", async () => {
    const inv = (await w.sale({ product: P, qty: "2", price: "1000", date: "2026-05-01", type: "CASH" })).id; const g = await w.getInvoice(inv);
    expect((await w.api(w.owner, w.R.invoiceReverse, { method: "POST", params: { id: inv }, body: { reason: "إلغاء", receiptHandling: "KEEP_AS_CREDIT" } })).status).toBe(200);
    const c0 = await cashNet(w.ids.cashIQD), cr0 = bal(await w.tb(), "2400"); expect(cr0).toBe(-2000);
    const over = await refund({ customerId: g.customerId, cashAccountId: w.ids.cashIQD, amount: "2500" }); expect(over.status).toBe(409); expect(over.body.error.code).toBe("INSUFFICIENT_CREDIT");
    const usd = await refund({ customerId: g.customerId, cashAccountId: w.ids.cashUSD, amount: "1", exchangeRate: "1450" }); expect(usd.status).toBe(409);       // credit is IQD only
    const b = { customerId: g.customerId, cashAccountId: w.ids.cashIQD, amount: "1500", requestId: "rf-fixed-key-1" };
    const r = await refund(b); if (r.status !== 200) console.log("REFUNDERR", JSON.stringify(r.body)); expect(r.status).toBe(200);
    expect((await refund(b)).body.replayed).toBe(true);
    expect(await cashNet(w.ids.cashIQD) - c0).toBe(-1500); expect(bal(await w.tb(), "2400")).toBe(-500);
    expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
    const rv = await w.api(w.owner, (await import("@/app/api/customer-refunds/[id]/reverse/route")).POST, { method: "POST", params: { id: r.body.id }, body: { reason: "خطأ" } }); expect(rv.status).toBe(200);
    expect(await cashNet(w.ids.cashIQD)).toBe(c0); expect(bal(await w.tb(), "2400")).toBe(-2000); expect((await w.tb()).balanced).toBe(true);
  });
});
