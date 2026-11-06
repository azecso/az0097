import type { Tx } from "./db";
import type { Principal } from "./authz";
import { AppError } from "./errors";
import { unseal, verifyTotp } from "./totp";

/**
 * Critical owner actions (capital, profit settlement/payout, period reopening) require a fresh TOTP code.
 * If the owner has not enrolled yet, REQUIRE_OWNER_2FA (default true) blocks the action until they do.
 */
export async function requireStepUp(tx: Tx, who: Principal, code: string | null | undefined) {
  const [u] = await tx`SELECT totp_enabled, totp_secret_enc FROM users WHERE id = ${who.userId}`;
  if (!u?.totp_enabled) {
    if (process.env.REQUIRE_OWNER_2FA !== "false") throw new AppError(403, "TOTP_SETUP_REQUIRED", "فعّل المصادقة الثنائية أولاً من «الأمان» لتنفيذ العمليات الحساسة");
    return;
  }
  if (!code) throw new AppError(403, "TOTP_REQUIRED", "أدخل رمز المصادقة الثنائية");
  const step = verifyTotp(unseal(u.totp_secret_enc), code);
  if (step === null) throw new AppError(403, "TOTP_INVALID", "رمز المصادقة غير صحيح");
  const [ok] = await tx`SELECT auth_totp_use(${who.userId}, ${step}) AS ok`;
  if (!ok!.ok) throw new AppError(403, "TOTP_REPLAYED", "الرمز مستخدم مسبقاً؛ انتظر الرمز التالي");
}

/** Company switch (default OFF): ask for the owner's TOTP code when approving/paying profit settlements. Capital and period re-opening always require it. */
export async function profitStepUpRequired(tx: Tx) {
  const [c] = await tx`SELECT settings->>'profitStepUp' AS v FROM companies`;
  return c?.v === "true";
}
