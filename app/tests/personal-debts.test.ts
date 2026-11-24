import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeWorld, bal, type World } from "./world";

let w: World;
beforeAll(async () => { w = await makeWorld(); await w.fund("5000000"); });
afterAll(async () => { await w.env.teardown(); });
const cashNet = async () => Number((await w.env.admin`SELECT COALESCE(sum(amount),0)::text AS s FROM cash_movements WHERE cash_account_id = ${w.ids.cashIQD}`)[0]!.s);
const mod = async (m: string) => (await import(m));
const create = async (b: Record<string, unknown>, s = w.owner) => w.api(s, (await mod("@/app/api/personal-debts/route")).POST, { method: "POST", body: { requestId: `d-${Math.random().toString(36).slice(2)}-xx`, docDate: "2026-07-01", currency: "IQD", amount: "100000", ...b } });
const list = async () => (await w.api(w.owner, (await mod("@/app/api/personal-debts/route")).GET)).body;
const pay = async (id: string, b: Record<string, unknown>) => w.api(w.owner, (await mod("@/app/api/personal-debts/[id]/pay/route")).POST, { method: "POST", params: { id }, body: { requestId: `p-${Math.random().toString(36).slice(2)}-xx`, payDate: "2026-07-10", amount: "30000", ...b } });

describe("personal debt: documentation only, outside the cash box", () => {
  it("a debt for the owner / partner / a named person never touches the box, the ledger or profit", async () => {
    const c0 = await cashNet(), tb0 = await w.tb(), j0 = Number((await w.env.admin`SELECT count(*)::int AS n FROM journal_entries`)[0]!.n);
    const a = await create({ partnerKind: "OWNER", amount: "250000" }); const b = await create({ partnerKind: "PARTNER", amount: "100000" }); const c = await create({ person: "المدير أحمد", amount: "40" , currency: "USD" });
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]); expect(a.body.docNo).toMatch(/^PD-/);
    expect(await cashNet()).toBe(c0); expect(Number((await w.env.admin`SELECT count(*)::int AS n FROM journal_entries`)[0]!.n)).toBe(j0);
    expect(bal(await w.tb(), "1110")).toBe(bal(tb0, "1110")); expect((await w.tb()).balanced).toBe(true); expect((await w.recon()).ok).toBe(true);
    const l = await list(); expect(l.rows.length).toBe(3); expect(l.totals.map((t: any) => `${t.person}|${t.currency}|${Number(t.remaining)}`)).toContain("المدير أحمد|USD|40");
    expect((await create({})).status).toBe(400);                                                           // no person at all
    expect((await create({ person: "س" })).status).toBe(400);
    expect((await create({ person: "فلان", amount: "0" })).status).toBeGreaterThanOrEqual(400);
  });
  it("repayment is documentation outside the box: remaining falls, box unchanged; over-payment refused; idempotent; reversible", async () => {
    const d1 = (await create({ person: "علي", amount: "100000" })).body.id; const c0 = await cashNet();
    const r = await pay(d1, { amount: "30000" }); expect(r.status).toBe(200); expect(r.body.remaining).toBe("70000");
    expect(await cashNet()).toBe(c0);
    expect((await pay(d1, { amount: "80000" })).body.error.code).toBe("OVER_PAYMENT");
    expect((await pay(d1, { amount: "0" })).status).toBeGreaterThanOrEqual(400);
    const key = "p-fixed-key-0001"; expect((await pay(d1, { amount: "10000", requestId: key })).status).toBe(200); expect((await pay(d1, { amount: "10000", requestId: key })).body.replayed).toBe(true);
    let g = (await list()).rows.find((x: any) => x.id === d1); expect(Number(g.paid)).toBe(40000); expect(g.state).toBe("PARTIAL");
    const rev = (await mod("@/app/api/personal-debts/[id]/reverse/route")).POST, revPay = (await mod("@/app/api/personal-debt-payments/[id]/reverse/route")).POST;
    expect((await w.api(w.owner, rev, { method: "POST", params: { id: d1 }, body: { reason: "خطأ" } })).body.error.code).toBe("HAS_PAYMENTS");
    for (const p of g.payments) expect((await w.api(w.owner, revPay, { method: "POST", params: { id: p.id }, body: { reason: "سند خاطئ" } })).status).toBe(200);
    g = (await list()).rows.find((x: any) => x.id === d1); expect(Number(g.paid)).toBe(0); expect(g.state).toBe("OPEN");
    expect((await pay(d1, { amount: "100000" })).status).toBe(200); expect((await list()).rows.find((x: any) => x.id === d1).state).toBe("PAID");
    expect(await cashNet()).toBe(c0);
  });
  it("cancelling a debt keeps the record with its reason and removes it from what is owed", async () => {
    const id = (await create({ person: "خالد", amount: "5000" })).body.id;
    const rev = (await mod("@/app/api/personal-debts/[id]/reverse/route")).POST;
    expect((await w.api(w.owner, rev, { method: "POST", params: { id }, body: { reason: "إدخال خاطئ" } })).status).toBe(200);
    const g = (await list()).rows.find((x: any) => x.id === id); expect(g.state).toBe("REVERSED"); expect(g.reverseReason).toBe("إدخال خاطئ");
    expect((await list()).totals.some((t: any) => t.person === "خالد")).toBe(false);
    expect((await pay(id, { amount: "1000" })).body.error.code).toBe("DEBT_CANCELLED");
  });
});
