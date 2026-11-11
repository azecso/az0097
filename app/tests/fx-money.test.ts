import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, loginAs, setupDb, OWNER_PW, ACCT_PW, type TestEnv, type Session } from "./helpers";

let env: TestEnv; let owner: Session, acct: Session; let fx: any, login: any, audit: any;
beforeAll(async () => {
  env = await setupDb();
  login = (await import("@/app/api/auth/login/route")).POST;
  fx = await import("@/app/api/fx-rates/route");
  audit = (await import("@/app/api/audit/route")).GET;
  owner = await loginAs(login, "owner", OWNER_PW);
  const users = await import("@/app/api/users/route");
  await call(users.POST, { method: "POST", session: owner, body: { username: "acc", displayName: "المحاسب", password: ACCT_PW } });
  acct = await loginAs(login, "acc", ACCT_PW);
});
afterAll(async () => { await env.teardown(); });

describe("FX rates (IQD per 1 USD, manual, per day)", () => {
  const post = (s: Session, body: unknown) => call(fx.POST, { method: "POST", session: s, body });
  it("rejects a rate for the base currency, non-positive and absurd rates, and float-like garbage", async () => {
    expect((await post(owner, { currency: "IQD", rateDate: "2026-11-02", rate: "1" })).body.error.code).toBe("BASE_CURRENCY_RATE");
    expect((await post(owner, { currency: "USD", rateDate: "2026-11-02", rate: "0" })).status).toBe(400);
    expect((await post(owner, { currency: "USD", rateDate: "2026-11-02", rate: "-5" })).status).toBe(400);
    expect((await post(owner, { currency: "USD", rateDate: "2026-11-02", rate: "1e3" })).status).toBe(400);
    expect((await post(owner, { currency: "USD", rateDate: "2026-11-02", rate: "0.5" })).body.error.code).toBe("RATE_OUT_OF_RANGE");
    expect((await post(owner, { currency: "EUR", rateDate: "2026-11-02", rate: "1500" })).body.error.code).toBe("UNKNOWN_CURRENCY");
  });
  it("stores exact decimals, lets the accountant (default grant) record a rate, and audits edits with before/after", async () => {
    const a = await post(owner, { currency: "USD", rateDate: "2026-11-02", rate: "1480.12345678" });
    expect(a.body.rate).toBe("1480.12345678");                       // exact string round-trip, no float drift
    const b = await post(acct, { currency: "USD", rateDate: "2026-11-02", rate: "1485" });
    expect(b.status).toBe(200); expect(b.body.id).toBe(a.body.id);   // same day => update, not duplicate
    const log = (await call(audit, { session: owner })).body.filter((x: any) => x.action === "fx.update");
    expect(log[0].before.rate).toBe("1480.12345678"); expect(log[0].after.rate).toBe("1485.00000000"); expect(log[0].user).toBe("acc");
  });
  it("rateOn picks the latest rate on or before the date", async () => {
    await post(owner, { currency: "USD", rateDate: "2026-11-10", rate: "1500" });
    const { rateOn } = await import("@/lib/services/fx");
    const { withTenant } = await import("@/lib/db");
    const r = await withTenant(env.companyId, (tx) => rateOn(tx, "USD", "2026-11-09"));
    expect(r).toEqual({ rate: "1485.00000000", rateDate: "2026-11-02" });
    expect(await withTenant(env.companyId, (tx) => rateOn(tx, "USD", "2026-10-01"))).toBeNull();
  });
});

describe("money helpers (decimal.js, never float)", () => {
  it("rounds half-up per currency and avoids binary float errors", async () => {
    const m = await import("@/lib/money");
    expect(m.d("0.1").plus("0.2").toString()).toBe("0.3");
    expect(m.roundMoney("1000.5", "IQD").toString()).toBe("1001");
    expect(m.roundMoney("1.005", "USD").toString()).toBe("1.01");
    expect(m.toBase("1000", "1450", "USD").toString()).toBe("1450000");
    expect(m.toBase("12.34", "1480.5", "USD").toString()).toBe("18269");
    expect(() => m.roundMoney("1", "XXX")).toThrow();
  });
  it("splits 50/50 without losing a dinar: partner floors, owner takes the remainder", async () => {
    const { split5050 } = await import("@/lib/money");
    const s = split5050("1000001");
    expect(s.partner.toString()).toBe("500000"); expect(s.owner.toString()).toBe("500001");
    expect(split5050("1000000").owner.toString()).toBe("500000");
  });
  it("FX gain on settlement matches the design example (30,000 IQD on 1,000 USD, 1450 -> 1480)", async () => {
    const { toBase } = await import("@/lib/money");
    expect(toBase("1000", "1480", "USD").minus(toBase("1000", "1450", "USD")).toString()).toBe("30000");
  });
});

describe("company settings", () => {
  it("owner can update with optimistic concurrency and the change is audited", async () => {
    const co = await import("@/app/api/company/route");
    const g = (await call(co.GET, { session: owner })).body;
    const u = await call(co.PATCH, { method: "PATCH", session: owner, body: { name: "شركة الاختبار المحدثة", phones: ["07700000000"], allowNegativeStock: false, landedCostPolicy: "EXCLUDE", version: g.version } });
    expect(u.status).toBe(200); expect(u.body.version).toBe(g.version + 1);
    const neg = await call(co.PATCH, { method: "PATCH", session: owner, body: { name: "شركة", phones: [], allowNegativeStock: true, version: u.body.version } });  // negative stock is still unsupported
    expect(neg.body.error.code).toBe("NOT_IMPLEMENTED");
    const stale = await call(co.PATCH, { method: "PATCH", session: owner, body: { name: "x1", phones: [], version: g.version } });
    expect(stale.status).toBe(409);
  });
});

describe("rate check is advisory only", () => {
  it("reports 100 USD in dinars, a stale stored rate and a far-off typed rate without changing anything", async () => {
    const w2 = await (await import("./world")).makeWorld();
    try {
      const chk = (q: string) => w2.api(w2.owner, w2.R.fxCheck, { path: "/api/fx-rates/check?" + q } as any);
      const ok = (await chk("currency=USD&date=2026-01-02")).body; expect(ok.per100).toBe("145000"); expect(ok.warnings).toEqual([]);
      const stale = (await chk("currency=USD&date=2026-01-20")).body; expect(stale.warnings).toContain("STALE_RATE");
      const far = (await chk("currency=USD&date=2026-01-02&rate=148")).body; expect(far.warnings).toContain("BIG_CHANGE");
      const typed = (await chk("currency=USD&date=2026-01-02&rate=1480")).body; expect(typed.per100).toBe("148000"); expect(typed.warnings).toEqual([]);
      expect((await w2.api(w2.owner, w2.R.fx, { method: "POST", body: { currency: "USD", rateDate: "2026-01-02", rate: "1455" } })).status).toBe(200);
    } finally { await w2.env.teardown(); }
  });
});
