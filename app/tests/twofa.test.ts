import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeWorld, type World } from "./world";
import { call } from "./helpers";
import { hotp, stepOf } from "@/lib/totp";

let w: World; let secret = "";
beforeAll(async () => { w = await makeWorld(); });
afterAll(async () => { vi.useRealTimers(); await w.env.teardown(); });
const at = (steps: number) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + steps * 30_000); };
const code = (extra = 0) => hotp(secret, stepOf() + extra);
const req = async (amount = "1000") => (await w.api(w.owner, w.R.capital.POST, { method: "POST", body: { kind: "INJECTION", docDate: "2026-01-02", cashAccountId: w.ids.cashIQD, currency: "IQD", amount, reason: "اختبار 2FA" } })).body.id;

describe("owner 2FA (TOTP) as step-up for critical actions", () => {
  it("with 2FA required but not enrolled, critical approvals are refused until the owner enrolls", async () => {
    process.env.REQUIRE_OWNER_2FA = "true";
    const r = await w.api(w.owner, w.R.capitalApprove, { method: "POST", params: { id: await req() }, body: {} });
    expect(r.status).toBe(403); expect(r.body.error.code).toBe("TOTP_SETUP_REQUIRED");
  });
  it("enrol: secret is stored sealed (never plain), wrong code refused, right code enables", async () => {
    const s = await w.api(w.owner, w.R.totp.POST, { method: "POST", body: { action: "setup" } });
    secret = s.body.secret; expect(secret).toMatch(/^[A-Z2-7]{32}$/); expect(s.body.otpauth).toContain("otpauth://totp/");
    const row = await w.env.admin`SELECT totp_secret_enc, totp_enabled FROM users WHERE is_owner`;
    expect(row[0]!.totp_secret_enc).not.toContain(secret); expect(row[0]!.totp_enabled).toBe(false);
    expect((await w.api(w.owner, w.R.totp.POST, { method: "POST", body: { action: "enable", code: "000000" } })).body.error.code).toBe("TOTP_INVALID");
    expect((await w.api(w.owner, w.R.totp.POST, { method: "POST", body: { action: "enable", code: code() } })).status).toBe(200);
    expect((await w.api(w.owner, w.R.totp.GET)).body.enabled).toBe(true);
  });
  it("a critical action needs a fresh valid code; a code cannot be replayed", async () => {
    at(1);
    const id = await req();
    expect((await w.api(w.owner, w.R.capitalApprove, { method: "POST", params: { id }, body: {} })).body.error.code).toBe("TOTP_REQUIRED");
    expect((await w.api(w.owner, w.R.capitalApprove, { method: "POST", params: { id }, body: { totp: "123456" } })).body.error.code).toBe("TOTP_INVALID");
    const c = code();
    expect((await w.api(w.owner, w.R.capitalApprove, { method: "POST", params: { id }, body: { totp: c } })).status).toBe(200);
    const id2 = await req("2000");
    expect((await w.api(w.owner, w.R.capitalApprove, { method: "POST", params: { id: id2 }, body: { totp: c } })).body.error.code).toBe("TOTP_REPLAYED");
    at(1);
    expect((await w.api(w.owner, w.R.capitalApprove, { method: "POST", params: { id: id2 }, body: { totp: code() } })).status).toBe(200);
  });
  it("login requires the second factor once enabled; wrong codes count as failures", async () => {
    at(1);
    const body = { username: "owner", password: "Owner-Pass-2026-x1" };
    expect((await call(w.R.login, { method: "POST", body })).body.error.code).toBe("TOTP_REQUIRED");
    expect((await call(w.R.login, { method: "POST", body: { ...body, totp: "111111" } })).status).toBe(401);
    expect((await call(w.R.login, { method: "POST", body: { ...body, totp: code() } })).status).toBe(200);
    expect((await call(w.R.login, { method: "POST", body: { ...body, totp: code() } })).status).toBe(401);          // same code twice
  });
  it("the accountant is unaffected (no 2FA) and still cannot approve; disabling requires a valid code", async () => {
    expect((await w.api(w.acct, w.R.capitalApprove, { method: "POST", params: { id: await req("5") }, body: {} })).status).toBe(403);
    at(1);
    expect((await w.api(w.owner, w.R.totp.POST, { method: "POST", body: { action: "disable" } })).body.error.code).toBe("TOTP_REQUIRED");
    expect((await w.api(w.owner, w.R.totp.POST, { method: "POST", body: { action: "disable", code: code() } })).status).toBe(200);
    process.env.REQUIRE_OWNER_2FA = "false";
  });
});
