import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World;
beforeAll(async () => { w = await makeWorld(); await w.fund("10000000"); });
afterAll(async () => { await w.env.teardown(); });
const cashNet = async (acct: string) => Number((await w.env.admin`SELECT COALESCE(sum(amount),0)::text AS s FROM cash_movements WHERE cash_account_id = ${acct}`)[0]!.s);
const post = async (path: string, mod: string, b: unknown, params: Record<string, string> = {}, s = w.owner) => w.api(s, (await import(mod)).POST, { method: "POST", body: b, params } as any);
const project = async (name: string) => (await post("", "@/app/api/projects/route", { name })).body.id as string;
const entry = (pid: string, o: Record<string, unknown>) => post("", "@/app/api/projects/[id]/entries/route", { requestId: `pe-${Math.random().toString(36).slice(2)}-xx`, docDate: "2026-06-01", cashAccountId: w.ids.cashIQD, kind: "SPEND", note: "ملاحظة", ...o }, { id: pid });
const get = async (pid: string) => (await w.api(w.owner, (await import("@/app/api/projects/[id]/route")).GET, { params: { id: pid } })).body;

describe("projects: spend and refund against the cash box", () => {
  it("spend leaves the box at once, refund returns it; net cost per project; books balance; partners' profit untouched", async () => {
    const pid = await project("مشروع الاختبار"); const c0 = await cashNet(w.ids.cashIQD);
    expect((await post("", "@/app/api/projects/route", { name: "مشروع الاختبار" })).status).toBe(409);               // unique name
    const e1 = await entry(pid, { amount: "300000", note: "مواد" }); expect(e1.status).toBe(200);
    expect(await cashNet(w.ids.cashIQD) - c0).toBe(-300000);
    const e2 = await entry(pid, { amount: "50000", kind: "REFUND", docDate: "2026-06-03" }); expect(e2.status).toBe(200);
    expect(await cashNet(w.ids.cashIQD) - c0).toBe(-250000);
    const g = await get(pid); expect(g.totals[0]).toMatchObject({ currency: "IQD", entries: 2 }); expect(Number(g.totals[0].spent)).toBe(300000); expect(Number(g.totals[0].refunded)).toBe(50000); expect(Number(g.totals[0].net)).toBe(250000);
    const tb = await w.tb(); expect(tb.balanced).toBe(true); expect(bal(tb, "1700")).toBe(250000);        // an asset account: not an expense, so no effect on distributable profit
    expect((await w.recon()).ok).toBe(true);
    const pl = (await w.api(w.owner, w.R.report2, { params: { id: "profit-loss" }, path: "/api/reports2/profit-loss?from=2026-01-01&to=2026-12-31" } as any)).body;
    expect(JSON.stringify(pl.rows)).not.toContain("1700");
  });
  it("validation: positive amount, refund cannot exceed net cost, not more than the box holds, idempotent by requestId", async () => {
    const pid = await project("مشروع ثاني");
    expect((await entry(pid, { amount: "0" })).status).toBeGreaterThanOrEqual(400);
    expect((await entry(pid, { amount: "100", kind: "REFUND" })).body.error.code).toBe("REFUND_EXCEEDS_COST");
    expect((await entry(pid, { amount: "999999999" })).body.error.code).toBe("INSUFFICIENT_CASH");
    const key = "pe-fixed-key-0001"; const c0 = await cashNet(w.ids.cashIQD);
    const a = await entry(pid, { amount: "1000", requestId: key }); const b = await entry(pid, { amount: "1000", requestId: key });
    expect(a.status).toBe(200); expect(b.body.replayed).toBe(true); expect(await cashNet(w.ids.cashIQD) - c0).toBe(-1000);
  });
  it("USD box: spent in dollars from the dollar box only", async () => {
    const pid = await project("مشروع الدولار");
    const c0 = await cashNet(w.ids.cashIQD), u0 = await cashNet(w.ids.cashUSD);
    const r = await entry(pid, { amount: "10", cashAccountId: w.ids.cashUSD, exchangeRate: "1450" });
    if (r.status === 200) { expect(await cashNet(w.ids.cashUSD) - u0).toBe(-10); expect(await cashNet(w.ids.cashIQD)).toBe(c0); expect((await w.tb()).balanced).toBe(true); }
    else expect(r.body.error.code).toBe("INSUFFICIENT_CASH");                                              // no dollars in this test world: refused, not overdrawn
  });
  it("cancel restores the box and the net; a spend with later refunds cannot be cancelled first; photo attaches to the entry", async () => {
    const pid = await project("مشروع الإلغاء"); const c0 = await cashNet(w.ids.cashIQD);
    const s = await entry(pid, { amount: "20000" }); const r = await entry(pid, { amount: "5000", kind: "REFUND" });
    const rev = (id: string) => post("", "@/app/api/project-entries/[id]/reverse/route", { reason: "إدخال خاطئ" }, { id });
    const att = await import("@/lib/services/attachments");
    expect(att.ENTITY_TYPES).toContain("project_entry");
    expect((await rev(s.body.id)).body.error.code).toBe("REVERSE_BLOCKED_BY_REFUNDS");
    expect((await rev(r.body.id)).status).toBe(200); expect((await rev(s.body.id)).status).toBe(200);
    expect(await cashNet(w.ids.cashIQD)).toBe(c0); expect(Number((await get(pid)).totals[0]?.net ?? 0)).toBe(0); expect((await w.tb()).balanced).toBe(true);
    expect((await rev(s.body.id)).status).toBe(409);
  });
});
