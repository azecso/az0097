import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, loginAs, setupDb, OWNER_PW, ACCT_PW, type TestEnv, type Session } from "./helpers";

let env: TestEnv; let owner: Session, acct: Session; let acctId: string;
let R: Record<string, any> = {};
beforeAll(async () => {
  env = await setupDb();
  R.login = (await import("@/app/api/auth/login/route")).POST;
  R.users = await import("@/app/api/users/route");
  R.user = await import("@/app/api/users/[id]/route");
  R.perms = await import("@/app/api/users/[id]/permissions/route");
  R.company = await import("@/app/api/company/route");
  R.audit = await import("@/app/api/audit/route");
  R.fx = await import("@/app/api/fx-rates/route");
  owner = await loginAs(R.login, "owner", OWNER_PW);
  const c = await call(R.users.POST, { method: "POST", session: owner, body: { username: "acc", displayName: "المحاسب", password: ACCT_PW } });
  expect(c.status).toBe(200); acctId = c.body.id;
  acct = await loginAs(R.login, "acc", ACCT_PW);
});
afterAll(async () => { await env.teardown(); });

describe("RBAC enforced on the server", () => {
  it("accountant gets the default non-owner permission template only", async () => {
    const rows = await env.admin`SELECT pm.resource, pm.action, pm.owner_only FROM user_permissions up JOIN permissions pm ON pm.id = up.permission_id WHERE up.user_id = ${acctId}`;
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.some((r) => r.owner_only)).toBe(false);
  });
  it("accountant cannot list/create/edit users or touch permissions (incl. their own)", async () => {
    expect((await call(R.users.GET, { session: acct })).status).toBe(403);
    expect((await call(R.users.POST, { method: "POST", session: acct, body: { username: "x1x", displayName: "xx", password: ACCT_PW } })).status).toBe(403);
    expect((await call(R.user.PATCH, { method: "PATCH", session: acct, params: { id: acctId }, body: { status: "ACTIVE", version: 1 } })).status).toBe(403);
    const self = await call(R.perms.PUT, { method: "PUT", session: acct, params: { id: acctId }, body: { permissions: [{ resource: "capital_withdrawal", action: "approve" }] } });
    expect(self.status).toBe(403);
  });
  it("accountant cannot edit company settings (owner-only) but can view", async () => {
    expect((await call(R.company.GET, { session: acct })).status).toBe(200);
    const g = (await call(R.company.GET, { session: owner })).body;
    expect((await call(R.company.PATCH, { method: "PATCH", session: acct, body: { name: "هاك", phones: [], version: g.version } })).status).toBe(403);
  });
  it("accountant has no audit access by default", async () => {
    expect((await call(R.audit.GET, { session: acct })).status).toBe(403);
    expect((await call(R.audit.GET, { session: owner })).status).toBe(200);
  });
  it("owner cannot grant owner-only permissions (capital withdrawal approval) to the accountant", async () => {
    const r = await call(R.perms.PUT, { method: "PUT", session: owner, params: { id: acctId }, body: { permissions: [{ resource: "capital_withdrawal", action: "approve" }] } });
    expect(r.status).toBe(400); expect(r.body.error.code).toBe("OWNER_ONLY_PERMISSION");
  });
  it("owner can adjust accountant permissions; changes take effect immediately and are audited", async () => {
    const before = await call(R.fx.GET, { session: acct });
    expect(before.status).toBe(200);
    const upd = await call(R.perms.PUT, { method: "PUT", session: owner, params: { id: acctId }, body: { permissions: [{ resource: "company", action: "view" }] } });
    expect(upd.status).toBe(200);
    expect((await call(R.fx.GET, { session: acct })).status).toBe(403);          // fx_rate:view removed
    const log = await env.admin`SELECT action, before_data, after_data FROM audit_logs WHERE action = 'user.permissions.set'`;
    expect(log.length).toBe(1); expect(log[0]!.before_data.length).toBeGreaterThan(20); expect(log[0]!.after_data.length).toBe(1);
  });
  it("rejects unknown permissions", async () => {
    const r = await call(R.perms.PUT, { method: "PUT", session: owner, params: { id: acctId }, body: { permissions: [{ resource: "nuke", action: "view" }] } });
    expect(r.status).toBe(400);
  });
  it("database refuses owner-only grants and self-grants even if the app were bypassed", async () => {
    const [p] = await env.app`SELECT id FROM permissions WHERE resource='capital_withdrawal' AND action='approve'`;
    await expect(env.app`INSERT INTO user_permissions(user_id,permission_id,granted_by) VALUES (${acctId}, ${p!.id}, ${env.ownerId})`).rejects.toThrow(/OWNER_ONLY_PERMISSION/);
    const [q] = await env.app`SELECT id FROM permissions WHERE resource='sales' AND action='view'`;
    await expect(env.app`INSERT INTO user_permissions(user_id,permission_id,granted_by) VALUES (${acctId}, ${q!.id}, ${acctId})`).rejects.toThrow();
  });
  it("disabling a user revokes their sessions; owner account is immutable via API", async () => {
    const s = await loginAs(R.login, "acc", ACCT_PW);
    const cur = (await call(R.users.GET, { session: owner })).body.find((u: any) => u.id === acctId);
    const r = await call(R.user.PATCH, { method: "PATCH", session: owner, params: { id: acctId }, body: { status: "DISABLED", version: cur.version } });
    expect(r.status).toBe(200);
    expect((await call(R.company.GET, { session: s })).status).toBe(401);
    const ownerRow = (await call(R.users.GET, { session: owner })).body.find((u: any) => u.isOwner);
    expect((await call(R.user.PATCH, { method: "PATCH", session: owner, params: { id: ownerRow.id }, body: { status: "DISABLED", version: ownerRow.version } })).status).toBe(400);
  });
  it("optimistic concurrency: stale version is rejected with 409", async () => {
    const r = await call(R.user.PATCH, { method: "PATCH", session: owner, params: { id: acctId }, body: { displayName: "اسم جديد", version: 1 } });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe("VERSION_CONFLICT");
  });
  it("weak passwords are rejected", async () => {
    const r = await call(R.users.POST, { method: "POST", session: owner, body: { username: "weak1", displayName: "ضعيف", password: "short1" } });
    expect(r.status).toBe(400); expect(r.body.error.code).toBe("WEAK_PASSWORD");
  });
});
