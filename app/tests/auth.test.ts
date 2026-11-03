import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, loginAs, setupDb, OWNER_PW, type TestEnv, type Session } from "./helpers";

let env: TestEnv; let login: any, logout: any, me: any, users: any;
beforeAll(async () => {
  env = await setupDb();
  login = (await import("@/app/api/auth/login/route")).POST;
  logout = (await import("@/app/api/auth/logout/route")).POST;
  me = (await import("@/app/api/auth/me/route")).GET;
  users = (await import("@/app/api/users/route")).GET;
});
afterAll(async () => { await env.teardown(); });

describe("authentication", () => {
  it("logs in, sets an HttpOnly SameSite=Lax cookie and stores only a hash of the token", async () => {
    const r = await call(login, { method: "POST", body: { username: "owner", password: OWNER_PW } });
    expect(r.status).toBe(200);
    const c = r.headers.get("set-cookie")!;
    expect(c).toMatch(/HttpOnly/i); expect(c).toMatch(/SameSite=lax/i);
    const token = c.split(";")[0]!.split("=")[1]!;
    const rows = await env.admin`SELECT encode(id_hash,'escape') AS h FROM sessions`;
    expect(rows.some((x) => x.h === token)).toBe(false);   // raw token never stored
  });
  it("rejects wrong password and unknown user with the same generic error", async () => {
    const a = await call(login, { method: "POST", body: { username: "owner", password: "wrong-password-123" } });
    const b = await call(login, { method: "POST", body: { username: "nobody", password: "wrong-password-123" } });
    expect(a.status).toBe(401); expect(b.status).toBe(401);
    expect(a.body.error.code).toBe(b.body.error.code);
  });
  it("blocks cross-origin login (CSRF defense)", async () => {
    const r = await call(login, { method: "POST", origin: "http://evil.example", body: { username: "owner", password: OWNER_PW } });
    expect(r.status).toBe(403);
  });
  it("requires a session for protected routes", async () => {
    expect((await call(users)).status).toBe(401);
    expect((await call(me)).status).toBe(401);
  });
  it("requires the CSRF token and same-origin on mutations", async () => {
    const s = await loginAs(login, "owner", OWNER_PW);
    const post = (await import("@/app/api/users/route")).POST;
    const body = { username: "csrf.test", displayName: "اختبار", password: "Another-Pass-2026-z3" };
    expect((await call(post, { method: "POST", session: s, csrf: null, body })).body.error.code).toBe("BAD_CSRF");
    expect((await call(post, { method: "POST", session: s, csrf: "bad", body })).body.error.code).toBe("BAD_CSRF");
    expect((await call(post, { method: "POST", session: s, origin: "http://evil.example", body })).body.error.code).toBe("BAD_ORIGIN");
    expect((await call(post, { method: "POST", session: s, origin: null, body })).status).toBe(403);
  });
  it("logout revokes the session server-side", async () => {
    const s = await loginAs(login, "owner", OWNER_PW);
    expect((await call(me, { session: s })).status).toBe(200);
    expect((await call(logout, { method: "POST", session: s })).status).toBe(200);
    expect((await call(me, { session: s })).status).toBe(401);
  });
  it("locks the account after 5 failures, even for the correct password, and unlocks by time", async () => {
    await env.admin`INSERT INTO users(company_id,username,display_name,password_hash,created_by)
      SELECT ${env.companyId}, 'lockme', 'x', password_hash, ${env.ownerId} FROM users WHERE is_owner`;
    for (let i = 0; i < 5; i++) await call(login, { method: "POST", body: { username: "lockme", password: "bad-password-000" } });
    const r = await call(login, { method: "POST", body: { username: "lockme", password: OWNER_PW } });
    expect(r.status).toBe(401);
    await env.admin`UPDATE users SET locked_until = now() - interval '1 minute' WHERE username='lockme'`;
    expect((await call(login, { method: "POST", body: { username: "lockme", password: OWNER_PW } })).status).toBe(200);
  });
  it("expired or idle sessions are rejected", async () => {
    const s = await loginAs(login, "owner", OWNER_PW);
    await env.admin`UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE revoked_at IS NULL`;
    expect((await call(me, { session: s })).status).toBe(401);
  });
  it("stores password hashes as Argon2id", async () => {
    const [u] = await env.admin`SELECT password_hash FROM users WHERE is_owner`;
    expect(u!.password_hash).toMatch(/^\$argon2id\$/);
  });
});
