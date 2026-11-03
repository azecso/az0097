import postgres from "postgres";

declare global { var __sql: postgres.Sql | undefined }

function create() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return postgres(url, { max: Number(process.env.DB_POOL_MAX ?? 10), onnotice: () => {} });
}
const get = () => (globalThis.__sql ??= create());
/** Lazy: the pool is created on first use so importing this module never requires DATABASE_URL (build, scripts, tests). */
export const sql: postgres.Sql = new Proxy(function () {} as unknown as postgres.Sql, {
  apply: (_t, _this, args) => (get() as unknown as (...a: unknown[]) => unknown)(...args),
  get: (_t, prop) => { const s = get() as unknown as Record<string | symbol, unknown>; const v = s[prop]; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(s) : v; },
});
export type Tx = postgres.TransactionSql;

/** Runs fn in ONE transaction scoped to a tenant: RLS (app.company_id) applies to every statement. */
export async function withTenant<T>(companyId: string, fn: (tx: Tx) => Promise<T>, db: postgres.Sql = sql): Promise<T> {
  return (await db.begin(async (tx) => {
    await tx`SELECT set_config('app.company_id', ${companyId}, true)`;
    return fn(tx);
  })) as T;
}
