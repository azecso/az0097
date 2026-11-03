import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { migrate } from "../scripts/migrate";
import { bootstrapCompany } from "../scripts/bootstrap";

const ADMIN = process.env.TEST_ADMIN_URL ?? "postgres://postgres@127.0.0.1:55432/postgres";
export const OWNER_PW = "Owner-Pass-2026-x1";
export const ACCT_PW = "Accountant-Pass-2026-y2";
export const ORIGIN = "http://localhost:3000";

export interface TestEnv { admin: postgres.Sql; app: postgres.Sql; dbName: string; companyId: string; ownerId: string; appUrl: string; adminDbUrl: string; teardown: () => Promise<void> }

/** Fresh database per test file, migrated + bootstrapped, with the least-privilege app role. */
export async function setupDb(): Promise<TestEnv> {
  const base = postgres(ADMIN, { max: 1, onnotice: () => {} });
  const dbName = "erp_t_" + randomBytes(5).toString("hex");
  await base.unsafe(`CREATE DATABASE ${dbName}`);
  await base.end();
  const u = new URL(ADMIN); u.pathname = "/" + dbName;
  const adminDbUrl = u.toString();
  const appUser = "erp_app_test", appPw = "app-test-pw-" + randomBytes(4).toString("hex");
  await migrate(adminDbUrl, { user: appUser, password: appPw });
  const admin = postgres(adminDbUrl, { max: 2, onnotice: () => {} });
  const { companyId, ownerId } = await bootstrapCompany(admin, { companyName: "شركة الاختبار", ownerUsername: "owner", ownerPassword: OWNER_PW });
  const au = new URL(adminDbUrl); au.username = appUser; au.password = appPw;
  const appUrl = au.toString();
  process.env.DATABASE_URL = appUrl;
  process.env.COOKIE_SECURE = "false";
  process.env.LOGIN_RATE_LIMIT = "1000";
  process.env.REQUIRE_OWNER_2FA = "false";
  const app = postgres(appUrl, { max: 5, onnotice: () => {} });
  return { admin, app, dbName, companyId, ownerId, appUrl, adminDbUrl, teardown: async () => {
    await app.end(); await admin.end();
    const b = postgres(ADMIN, { max: 1 });
    await b.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await b.end();
  } };
}

type Handler = (req: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
export interface Session { cookie: string; csrf: string }

export async function call(h: Handler, o: { method?: string; path?: string; body?: unknown; session?: Session | null; csrf?: string | null; origin?: string | null; params?: Record<string, string> } = {}) {
  const headers = new Headers({ host: "localhost:3000", "content-type": "application/json" });
  if (o.origin !== null) headers.set("origin", o.origin ?? ORIGIN);
  if (o.session) headers.set("cookie", o.session.cookie);
  const csrf = o.csrf === undefined ? o.session?.csrf : o.csrf;
  if (csrf) headers.set("x-csrf-token", csrf);
  const method = o.method ?? "GET";
  const req = new NextRequest(ORIGIN + (o.path ?? "/api/x"), { method, headers, body: method === "GET" ? undefined : JSON.stringify(o.body ?? {}) });
  const res = await h(req, { params: Promise.resolve(o.params ?? {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

export async function loginAs(loginHandler: Handler, username: string, password: string): Promise<Session> {
  const r = await call(loginHandler, { method: "POST", body: { username, password }, path: "/api/auth/login" });
  if (r.status !== 200) throw new Error("login failed " + JSON.stringify(r.body));
  const set = r.headers.get("set-cookie")!;
  return { cookie: set.split(";")[0]!, csrf: r.body.csrf };
}
