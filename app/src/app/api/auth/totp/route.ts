import { z } from "zod";
import { secured, parse } from "@/lib/http";
import { badRequest, conflict } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { newSecret, otpauthUri, seal, unseal, verifyTotp } from "@/lib/totp";
import { requireStepUp } from "@/lib/stepup";

export const GET = secured({}, async ({ tx, principal }) => { const [u] = await tx`SELECT totp_enabled FROM users WHERE id = ${principal.userId}`; return { enabled: !!u?.totp_enabled, required: process.env.REQUIRE_OWNER_2FA !== "false" }; });

/** POST {action:"setup"} -> new secret (not active yet); {action:"enable", code}; {action:"disable", code} */
export const POST = secured({}, async ({ tx, principal, actor, req }) => {
  const b = parse(z.object({ action: z.enum(["setup", "enable", "disable"]), code: z.string().max(10).optional() }), await req.json());
  const [u] = await tx`SELECT totp_enabled, totp_secret_enc FROM users WHERE id = ${principal.userId} FOR UPDATE`;
  if (b.action === "setup") {
    if (u!.totp_enabled) throw conflict("ALREADY_ENABLED");
    const secret = newSecret();
    await tx`UPDATE users SET totp_secret_enc = ${seal(secret)} WHERE id = ${principal.userId}`;
    return { secret, otpauth: otpauthUri(secret, principal.username) };
  }
  if (!u!.totp_secret_enc) throw badRequest("NO_SECRET", "ابدأ بالإعداد أولاً");
  if (b.action === "enable") {
    if (u!.totp_enabled) throw conflict("ALREADY_ENABLED");
    const step = verifyTotp(unseal(u!.totp_secret_enc), b.code ?? "");
    if (step === null) throw badRequest("TOTP_INVALID", "الرمز غير صحيح");
    await tx`UPDATE users SET totp_enabled = true, totp_last_step = ${step} WHERE id = ${principal.userId}`;
    await audit(tx, actor, { action: "auth.totp_enabled", entityType: "user", entityId: principal.userId });
    return { enabled: true };
  }
  await requireStepUp(tx, principal, b.code);                         // disabling needs a valid current code
  await tx`UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = ${principal.userId}`;
  await audit(tx, actor, { action: "auth.totp_disabled", entityType: "user", entityId: principal.userId });
  return { enabled: false };
});
