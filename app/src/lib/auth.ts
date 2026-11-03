import { hash, verify } from "@node-rs/argon2";
import { sql, withTenant } from "./db";
import { randomToken, sha256 } from "./crypto";
import { AppError, badRequest } from "./errors";
import type { Principal } from "./authz";
import type postgres from "postgres";
import { unseal, verifyTotp } from "./totp";

export const SESSION_COOKIE = "erp_session";
export const MAX_FAILS = 5, LOCK_MINUTES = 15, SESSION_HOURS = 12, IDLE_MINUTES = 60;

// Argon2id (algorithm: 2). Parameters follow OWASP guidance: m=19MiB, t=2, p=1 minimum; we use m=64MiB.
const ARGON = { algorithm: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
export const hashPassword = (pw: string) => hash(pw, ARGON);
export function assertStrongPassword(pw: string) {
  if (pw.length < 12) throw badRequest("WEAK_PASSWORD", "كلمة المرور يجب ألا تقل عن 12 حرفاً");
  if (pw.length > 256) throw badRequest("WEAK_PASSWORD", "كلمة المرور طويلة جداً");
  if (!/[A-Za-z؀-ۿ]/.test(pw) || !/[0-9]/.test(pw)) throw badRequest("WEAK_PASSWORD", "يجب أن تحتوي على حروف وأرقام");
}
let dummyHash: Promise<string> | undefined;

export interface LoginResult { token: string; csrf: string; principal: Principal }

export async function login(username: string, password: string, totp: string | undefined, meta: { ip?: string | null; ua?: string | null; deviceId?: string | null },
                            db: postgres.Sql = sql): Promise<LoginResult> {
  const rows = await db`SELECT * FROM auth_find_user(${username})`;
  const u = rows[0];
  // Always do one verify so timing doesn't reveal whether the username exists.
  const target = u?.password_hash ?? (await (dummyHash ??= hashPassword("dummy-password-for-timing-1")));
  const locked = !!u && (u.status !== "ACTIVE" || (u.locked_until && new Date(u.locked_until) > new Date()));
  const okPw = await verify(target, password).catch(() => false);
  if (!u || locked || !okPw) {
    if (u && !locked) await db`SELECT auth_record_failure(${u.id}, ${MAX_FAILS}, ${LOCK_MINUTES})`;
    throw new AppError(401, "INVALID_CREDENTIALS", "بيانات الدخول غير صحيحة أو الحساب مقفل مؤقتاً");
  }
  if (u.totp_enabled) {                         // password was right; now the second factor
    const step = totp ? verifyTotp(unseal(u.totp_secret_enc), totp) : null;
    if (!totp) throw new AppError(401, "TOTP_REQUIRED", "أدخل رمز المصادقة الثنائية");
    const used = step === null ? false : (await db`SELECT auth_totp_use(${u.id}, ${step}) AS ok`)[0]!.ok;
    if (!used) { await db`SELECT auth_record_failure(${u.id}, ${MAX_FAILS}, ${LOCK_MINUTES})`; throw new AppError(401, "INVALID_CREDENTIALS", "بيانات الدخول غير صحيحة أو الحساب مقفل مؤقتاً"); }
  }
  await db`SELECT auth_record_success(${u.id})`;
  const token = randomToken(32), csrf = randomToken(24);
  await db`SELECT auth_create_session(${sha256(token)}, ${u.id}, ${csrf}, ${meta.deviceId ?? null}, ${meta.ip ?? null}, ${meta.ua ?? null}, ${SESSION_HOURS})`;
  return { token, csrf, principal: { userId: u.id, companyId: u.company_id, isOwner: u.is_owner, username: u.username, displayName: u.display_name } };
}

export async function resolveSession(token: string | undefined, db: postgres.Sql = sql): Promise<{ principal: Principal; csrf: string } | null> {
  if (!token || token.length > 200) return null;
  const h = sha256(token);
  const r = (await db`SELECT * FROM auth_find_session(${h}, ${IDLE_MINUTES})`)[0];
  if (!r) return null;
  await db`SELECT auth_touch_session(${h})`;
  return { csrf: r.csrf_token, principal: { userId: r.user_id, companyId: r.company_id, isOwner: r.is_owner, username: r.username, displayName: r.display_name } };
}

export async function logout(token: string, db: postgres.Sql = sql) { await db`SELECT auth_revoke_session(${sha256(token)})`; }
export { withTenant };
