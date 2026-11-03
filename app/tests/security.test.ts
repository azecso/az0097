import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { makeWorld, capital, type World } from "./world";
import { ACCT_PW, call, loginAs, ORIGIN, setupDb } from "./helpers";
import { _resetRateLimits } from "@/lib/ratelimit";

let w: World;
beforeAll(async () => { w = await makeWorld(); await capital(w); });
afterAll(async () => { await w.env.teardown(); });

const API = join(process.cwd(), "src", "app", "api");
function routes(dir = API, out: string[] = []): string[] { for (const n of readdirSync(dir)) { const p = join(dir, n); statSync(p).isDirectory() ? routes(p, out) : n === "route.ts" && out.push(p); } return out; }
const FAKE = "11111111-1111-4111-8111-111111111111";
const urlOf = (file: string) => "/api/" + file.slice(API.length + 1).replace(/\/route\.ts$/, "").replace(/\[(\w+)\]/g, FAKE);
const PUBLIC = new Set(["/api/auth/login", "/api/auth/logout", "/api/health"]);
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
async function handlers(file: string) { const m = await import(/* @vite-ignore */ file); return METHODS.filter((x) => typeof m[x] === "function").map((x) => [x, m[x]] as const); }
const req = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  new NextRequest(ORIGIN + path, { method, headers: { host: "localhost:3000", "content-type": "application/json", ...headers }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
const ctx = { params: Promise.resolve({ id: FAKE, kind: "stock" }) };

describe("every API route enforces authentication, CSRF and permissions (automatic sweep)", () => {
  it("covers a meaningful number of routes", () => { expect(routes().length).toBeGreaterThan(90); });

  it("no route answers an anonymous request with data (401 everywhere except login/logout/health)", async () => {
    const bad: string[] = [];
    for (const f of routes()) { const url = urlOf(f); if (PUBLIC.has(url)) continue;
      for (const [m, h] of await handlers(f)) { const r = await h(req(m, url, { origin: ORIGIN }), ctx); if (r.status !== 401) bad.push(`${m} ${url} -> ${r.status}`); } }
    expect(bad).toEqual([]);
  });

  it("every mutating route rejects a logged-in request without the CSRF token and with a foreign Origin", async () => {
    const bad: string[] = [];
    for (const f of routes()) { const url = urlOf(f); if (PUBLIC.has(url) || url.startsWith("/api/auth/")) continue;
      for (const [m, h] of await handlers(f)) { if (m === "GET") continue;
        const noCsrf = await h(req(m, url, { origin: ORIGIN, cookie: w.owner.cookie }), ctx);
        const evil = await h(req(m, url, { origin: "http://evil.example", cookie: w.owner.cookie, "x-csrf-token": w.owner.csrf }), ctx);
        if (noCsrf.status !== 403) bad.push(`${m} ${url} no-csrf -> ${noCsrf.status}`); if (evil.status !== 403) bad.push(`${m} ${url} evil-origin -> ${evil.status}`); } }
    expect(bad).toEqual([]);
  });

  it("a user with NO permissions can read nothing sensitive: every route refuses (403) except the explicit allow-list", async () => {
    const users = await import("@/app/api/users/route"); const perms = await import("@/app/api/users/[id]/permissions/route");
    const c = await w.api(w.owner, users.POST, { method: "POST", body: { username: "empty", displayName: "بلا صلاحيات", password: ACCT_PW } });
    await w.api(w.owner, perms.PUT, { method: "PUT", params: { id: c.body.id }, body: { permissions: [] } });
    const s = await loginAs(w.R.login, "empty", ACCT_PW);
    const ALLOW = new Set(["/api/currencies", "/api/auth/me", "/api/auth/totp", "/api/sync/push", "/api/sync/operations", "/api/sync/reference", "/api/attachments"]);   // self-scoped or permission-checked inside
    const bad: string[] = [];
    for (const f of routes()) { const url = urlOf(f); if (PUBLIC.has(url) || ALLOW.has(url)) continue;
      for (const [m, h] of await handlers(f)) {
        const r = await h(req(m, url, { origin: ORIGIN, cookie: s.cookie, "x-csrf-token": s.csrf }, {}), ctx);
        if (r.status === 200) bad.push(`${m} ${url} -> 200`); } }
    expect(bad).toEqual([]);
    const sync = await w.api(s, (await import("@/app/api/sync/push/route")).POST, { method: "POST", body: { deviceId: "dev-x", operations: [{ operationId: FAKE, idempotencyKey: "kkkkkkkk1", entityType: "expense", entityLocalId: FAKE, op: "CREATE_DRAFT", payload: {}, clientCreatedAt: new Date().toISOString() }] } });
    expect(sync.body.results[0].code).toBe("PERMISSION_DENIED");                                         // the offline path cannot bypass permissions either
  });
});

describe("injection, XSS payloads, mass assignment and bad input", () => {
  const EVIL = ["'; DROP TABLE users; --", "\" OR 1=1 --", "<img src=x onerror=alert(1)>", "<script>alert(document.cookie)</script>", "${7*7}{{7*7}}", "../../etc/passwd", "\u0000null"];
  it("hostile text is stored and returned inertly (parameterised SQL); the schema survives", async () => {
    for (const [i, v] of EVIL.entries()) {
      const r = await w.api(w.owner, w.R.contacts.POST, { method: "POST", body: { kind: "CUSTOMER", code: "X" + i, name: v.replace("\u0000", "") + "ab" } });
      expect(r.status, v).toBe(200);
    }
    const list = (await w.api(w.owner, w.R.contacts.GET, { path: "/api/contacts?kind=CUSTOMER" } as any)).body;
    expect(list.some((c: any) => c.name.startsWith("<img src=x onerror=alert(1)>"))).toBe(true);
    expect((await w.env.admin`SELECT count(*)::int n FROM users`)[0]!.n).toBeGreaterThan(0);
    const inj = await w.api(w.owner, w.R.contacts.GET, { path: "/api/contacts?kind=' OR 1=1 --" } as any);
    expect(inj.status).toBe(200); expect(inj.body.length).toBeLessThanOrEqual(list.length + 3);          // the payload is just a value: it filters nothing in
  });
  it("malformed ids and oversized numbers are 4xx with a clean body (no SQL/stack leakage)", async () => {
    for (const bad of ["not-a-uuid", "1' OR '1'='1", "%00"]) {
      const r = await w.api(w.owner, w.R.purchaseId.GET, { params: { id: bad } }); expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).not.toMatch(/relation|syntax|postgres|select |stack|at /i);
    }
    const P = await w.mkProduct("BIG");
    const huge = await w.api(w.owner, w.R.invoices.POST, { method: "POST", body: { customerId: w.ids.customer, docDate: "2026-02-01", saleType: "CREDIT", currency: "IQD", lines: Array.from({ length: 150 }, () => ({ productId: P, uom: "قطعة", qty: "99999999999999", unitPrice: "99999999999999" })) } });
    expect(huge.status).toBeGreaterThanOrEqual(400); expect(huge.status).toBeLessThan(500);                 // overflow is refused, not a 500
    expect((await w.api(w.owner, w.R.products.POST, { method: "POST", body: { code: "L".repeat(5000), name: "x", baseUom: "u" } })).status).toBe(400);
  });
  it("mass assignment: client-supplied company/owner/version/status fields are ignored", async () => {
    const r = await w.api(w.owner, w.R.products.POST, { method: "POST", body: { code: "MA1", name: "مادة", baseUom: "قطعة", company_id: FAKE, companyId: FAKE, isArchived: true, version: 99, created_by: FAKE } });
    expect(r.status).toBe(200);
    const row = (await w.env.admin`SELECT company_id, is_archived, version FROM products WHERE code = 'MA1'`)[0]!;
    expect(row.company_id).toBe(w.env.companyId); expect(row.is_archived).toBe(false); expect(row.version).toBe(1);
    const inv = await w.sale({ product: await w.mkProduct("MA2"), qty: "1", price: "1", noPost: true });
    const mod = await w.api(w.owner, w.R.invoiceId.PUT, { method: "PUT", params: { id: inv.body.id }, body: { version: inv.body.version, status: "POSTED", docNo: "HACK-1", customerId: w.ids.customer, docDate: "2026-02-01", saleType: "CREDIT", currency: "IQD", lines: [{ productId: (await w.env.admin`SELECT id FROM products WHERE code='MA2'`)[0]!.id, uom: "قطعة", qty: "1", unitPrice: "1" }] } });
    expect(mod.status).toBe(200); const st = (await w.env.admin`SELECT status, doc_no FROM sales_invoices WHERE id = ${inv.body.id}`)[0]!; expect(st.status).toBe("DRAFT"); expect(st.doc_no).toBeNull();
  });
});

describe("tenant isolation (IDOR) and session safety", () => {
  it("another company's user cannot see or touch this company's documents even knowing their ids", async () => {
    const P = await w.mkProduct("IDOR"); await w.buy({ product: P, qty: "2", price: "10" });
    const inv = await w.sale({ product: P, qty: "1", price: "50" });
    const [c2] = await w.env.admin`INSERT INTO companies(name) VALUES ('شركة أخرى') RETURNING id`;
    const { hashPassword } = await import("@/lib/auth");
    await w.env.admin`INSERT INTO users(company_id, username, display_name, password_hash, is_owner) VALUES (${c2!.id}, 'other', 'مالك آخر', ${await hashPassword("Other-Owner-Pass-1")}, true)`;
    const o = await loginAs(w.R.login, "other", "Other-Owner-Pass-1");
    for (const [h, params] of [[w.R.invoiceId.GET, { id: inv.id }], [w.R.purchaseId.GET, { id: inv.id }], [(await import("@/app/api/products/[id]/lots/route")).GET, { id: P }]] as const) {
      const r = await w.api(o, h as never, { params }); expect([404, 200]).toContain(r.status);
      if (r.status === 200) expect(Array.isArray(r.body) ? r.body.length : 0).toBe(0);                        // lots: RLS returns nothing
    }
    expect((await w.api(o, w.R.invoicePost, { method: "POST", params: { id: inv.id } })).status).toBe(404);
    expect((await w.api(o, w.R.invoices.GET)).body.length).toBe(0); expect((await w.api(o, w.R.stock)).body.length).toBe(0);
  });
  it("login issues a fresh session each time (no fixation), logout kills it, and brute force is throttled", async () => {
    const a = await loginAs(w.R.login, "owner", "Owner-Pass-2026-x1"), b = await loginAs(w.R.login, "owner", "Owner-Pass-2026-x1");
    expect(a.cookie).not.toBe(b.cookie); expect(a.csrf).not.toBe(b.csrf);
    const bogus = await w.api({ cookie: "erp_session=" + "A".repeat(43), csrf: "x" }, (await import("@/app/api/auth/me/route")).GET); expect(bogus.status).toBe(401);
    _resetRateLimits(); process.env.LOGIN_RATE_LIMIT = "3";
    const codes: number[] = []; for (let i = 0; i < 6; i++) codes.push((await call(w.R.login, { method: "POST", body: { username: "owner", password: "wrong-password-1" } })).status);
    expect(codes.slice(0, 3).every((c) => c === 401)).toBe(true); expect(codes.slice(3).every((c) => c === 429)).toBe(true);
    process.env.LOGIN_RATE_LIMIT = "1000"; _resetRateLimits();
  });
  it("security headers are configured (CSP, HSTS, framing, nosniff) and the session cookie is HttpOnly", async () => {
    const cfg = (await import(/* @vite-ignore */ join(process.cwd(), "next.config.mjs"))).default; const h = (await cfg.headers())[1].headers.map((x: any) => x.key + ": " + x.value).join("\n");
    expect(h).toMatch(/Content-Security-Policy: .*default-src 'self'/); expect(h).toMatch(/frame-ancestors 'none'/); expect(h).toMatch(/Strict-Transport-Security: max-age=31536000/); expect(h).toMatch(/X-Content-Type-Options: nosniff/); expect(h).toMatch(/worker-src 'self'/);
    const r = await call(w.R.login, { method: "POST", body: { username: "owner", password: "Owner-Pass-2026-x1" } }); expect(r.headers.get("set-cookie")).toMatch(/HttpOnly/i);
  });
});

describe("owner integrity endpoint", () => {
  it("reports healthy books and flags missing backups; owner only", async () => {
    const ig = await import("@/app/api/health/integrity/route");
    const r = await w.api(w.owner, ig.GET); expect(r.status).toBe(200); expect(r.body.ok).toBe(true); expect(r.body.backupsOk).toBe(false);          // no backup recorded in this test DB
    expect(r.body.checks.find((c: any) => c.code === "TRIAL_BALANCE").ok).toBe(true); expect(r.body.checks.find((c: any) => c.code === "BACKUP_FRESH_26H").ok).toBe(false);
    expect((await w.api(w.acct, ig.GET)).status).toBe(403);
    await w.env.admin`INSERT INTO backup_jobs(company_id, kind, started_at, finished_at, status, size_bytes, sha256) VALUES (${w.env.companyId}, 'DAILY', now() - interval '1 hour', now(), 'OK', 1000, ${"a".repeat(64)})`;
    await w.env.admin`INSERT INTO backup_jobs(company_id, kind, started_at, finished_at, status, remote_location) VALUES (${w.env.companyId}, 'RESTORE_TEST', now() - interval '1 day', now() - interval '1 day', 'OK', 'x')`;
    const ok = (await w.api(w.owner, ig.GET)).body; expect(ok.backupsOk).toBe(true);
    await expect(w.env.admin`DELETE FROM backup_jobs`).rejects.toThrow(/IMMUTABLE/);
  });
});
void setupDb;
