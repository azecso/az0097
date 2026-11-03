import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupDb, type TestEnv } from "./helpers";

let env: TestEnv; let companyB: string; let userB: string;
beforeAll(async () => {
  env = await setupDb();
  const [c] = await env.admin`INSERT INTO companies(name) VALUES ('شركة أخرى') RETURNING id`; companyB = c!.id;
  const [u] = await env.admin`INSERT INTO users(company_id,username,display_name,password_hash) VALUES (${companyB},'userb','b','x') RETURNING id`; userB = u!.id;
  await env.admin`INSERT INTO fx_rates(company_id,currency,rate_date,rate,created_by) VALUES (${companyB},'USD','2026-11-01',1500,${userB})`;
  await env.admin`INSERT INTO audit_logs(company_id,user_id,action,entity_type) VALUES (${companyB},${userB},'x','y')`;
});
afterAll(async () => { await env.teardown(); });

const scoped = (id: string, fn: (tx: any) => Promise<any>) => env.app.begin(async (tx) => { await tx`SELECT set_config('app.company_id', ${id}, true)`; return fn(tx); });

describe("tenant isolation (RLS, enforced for the non-owner application role)", () => {
  it("a tenant sees only its own rows", async () => {
    const a = await scoped(env.companyId, async (tx) => ({
      users: await tx`SELECT username FROM users`, fx: await tx`SELECT 1 FROM fx_rates`, audit: await tx`SELECT company_id FROM audit_logs`, comp: await tx`SELECT id FROM companies` }));
    expect(a.users.map((u: any) => u.username)).toEqual(["owner"]);
    expect(a.fx.length).toBe(0);
    expect(a.audit.every((x: any) => x.company_id === env.companyId)).toBe(true);
    expect(a.comp.length).toBe(1);
    const b = await scoped(companyB, (tx) => tx`SELECT username FROM users`);
    expect(b.map((u: any) => u.username)).toEqual(["userb"]);
  });
  it("without a tenant context nothing is visible", async () => {
    expect((await env.app`SELECT * FROM users`).length).toBe(0);
    expect((await env.app`SELECT * FROM audit_logs`).length).toBe(0);
  });
  it("cannot write rows into another tenant", async () => {
    await expect(scoped(env.companyId, (tx) => tx`INSERT INTO fx_rates(company_id,currency,rate_date,rate,created_by) VALUES (${companyB},'USD','2026-11-02',1,${userB})`)).rejects.toThrow(/row-level security/);
    await expect(scoped(env.companyId, (tx) => tx`UPDATE users SET display_name='hacked' WHERE id=${userB}`).then((r) => r.count)).resolves.toBe(0);
  });
});

describe("database-level guarantees for the app role", () => {
  it("audit log is append-only and not deletable/truncatable by the application", async () => {
    await expect(scoped(env.companyId, (tx) => tx`UPDATE audit_logs SET action='z'`)).rejects.toThrow(/IMMUTABLE_TABLE|permission denied/);
    await expect(scoped(env.companyId, (tx) => tx`DELETE FROM audit_logs`)).rejects.toThrow(/permission denied/);
    await expect(env.app`TRUNCATE audit_logs`).rejects.toThrow(/permission denied/);
    await expect(env.app`DROP TABLE users`).rejects.toThrow(/must be owner|permission denied/);
  });
  it("app role cannot bypass RLS or be a superuser", async () => {
    const [r] = await env.app`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
  });
  it("only one owner per company and unique usernames", async () => {
    await expect(env.admin`INSERT INTO users(company_id,username,display_name,password_hash,is_owner) VALUES (${env.companyId},'owner2','x','x',true)`).rejects.toThrow(/one_owner_per_company/);
    await expect(env.admin`INSERT INTO users(company_id,username,display_name,password_hash) VALUES (${env.companyId},'owner','x','x')`).rejects.toThrow();
  });
  it("document numbers are unique and gapless under concurrency; rollback consumes nothing", async () => {
    const year = new Date().getUTCFullYear();
    const one = () => scoped(env.companyId, (tx) => tx`SELECT next_document_number(${env.companyId}, 'sales_invoice', ${year}) AS n`);
    const results = await Promise.all(Array.from({ length: 20 }, one));
    const nums = results.map((r: any) => Number(r[0].n.split("-")[2])).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    await scoped(env.companyId, async (tx) => { await tx`SELECT next_document_number(${env.companyId}, 'sales_invoice', ${year})`; throw new Error("boom"); }).catch(() => {});
    const next: any = await one();
    expect(next[0].n).toMatch(/-000021$/);
  });
  it("migrations were recorded and the chart of accounts is seeded", async () => {
    expect((await env.admin`SELECT name FROM schema_migrations`).length).toBeGreaterThan(0);
    const [a] = await env.admin`SELECT count(*)::int n FROM accounts WHERE company_id = ${env.companyId}`;
    expect(a!.n).toBeGreaterThanOrEqual(25);
  });
});
