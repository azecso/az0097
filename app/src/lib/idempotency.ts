import type { Tx } from "./db";
import type { Principal } from "./authz";
import { conflict } from "./errors";

/**
 * Runs `fn` at most once per (company, key). A retried or double-clicked request returns the stored response of the first one.
 * The key row lives in the SAME transaction as the work: if `fn` throws, everything (including the key) rolls back, so retrying after a failure is safe and never leaves an orphan document.
 * Two identical requests at the same time: the second waits on the unique key, then sees the committed response.
 */
export async function once<T>(tx: Tx, who: Principal, key: string, action: string, fn: () => Promise<T>): Promise<T> {
  const [ins] = await tx`INSERT INTO request_keys(company_id, key, action, created_by) VALUES (${who.companyId}, ${key}, ${action}, ${who.userId}) ON CONFLICT (company_id, key) DO NOTHING RETURNING key`;
  if (!ins) {
    const [e] = await tx`SELECT action, response FROM request_keys WHERE company_id = ${who.companyId} AND key = ${key}`;
    if (!e || e.action !== action || !e.response) throw conflict("REQUEST_KEY_REUSED", "مفتاح الطلب مستعمل لعملية أخرى أو لم تكتمل");
    return { ...(e.response as object), replayed: true } as T;
  }
  const out: T = await fn();
  await tx`UPDATE request_keys SET response = ${tx.json(out as never)} WHERE company_id = ${who.companyId} AND key = ${key}`;
  return out;
}
