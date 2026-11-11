import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, type World } from "./world";

let w: World; let P: string;
beforeAll(async () => { w = await makeWorld(); await w.fund("20000000"); P = await w.mkProduct("FD"); });
afterAll(async () => { await w.env.teardown(); });
const cogs = async (inv: string) => (await w.getInvoice(inv)).cogsBase;

describe("FIFO respects the movement date", () => {
  it("a delivery cannot consume a layer received after its date; it takes only what had arrived", async () => {
    await w.buy({ product: P, qty: "10", price: "1000", date: "2026-01-10" });
    await w.buy({ product: P, qty: "20", price: "2000", date: "2026-03-10" });
    const early = await w.sale({ product: P, qty: "15", price: "5000", date: "2026-02-10" });          // only 10 units existed on 10 Feb
    expect(early.status).toBe(409); expect(early.body.error.code).toBe("INSUFFICIENT_STOCK"); expect(early.body.error.message).toContain("2026-02-10");
    const ok = await w.sale({ product: P, qty: "10", price: "5000", date: "2026-02-10" }); expect(ok.status).toBe(200);
    expect(Number(await cogs(ok.id))).toBe(10000);                                                       // the January layer only
    const later = await w.sale({ product: P, qty: "5", price: "5000", date: "2026-03-15" }); expect(later.status).toBe(200);
    expect(Number(await cogs(later.id))).toBe(10000);                                                    // 5 x 2,000 from the March layer
  });
  it("a purchase entered late with an older date does not rewrite COGS already booked; it serves later movements in date order", async () => {
    const before = Number(await cogs((await w.env.admin`SELECT id FROM sales_invoices ORDER BY created_at LIMIT 1`)[0]!.id));
    await w.buy({ product: P, qty: "5", price: "500", date: "2026-01-05" });                           // late entry, dated before everything
    expect(Number(await cogs((await w.env.admin`SELECT id FROM sales_invoices ORDER BY created_at LIMIT 1`)[0]!.id))).toBe(before);
    const s = await w.sale({ product: P, qty: "5", price: "5000", date: "2026-04-01" }); expect(s.status).toBe(200);
    expect(Number(await cogs(s.id))).toBe(2500);                                                         // the cheapest, oldest layer is next in FIFO order (policy: late entries are not back-dated into past COGS)
    expect((await w.recon()).ok).toBe(true);
  });
});
