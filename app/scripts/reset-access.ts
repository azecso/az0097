// Emergency access recovery, run ON THE SERVER as the DB owner (never exposed over HTTP).
//   OWNER_USERNAME=owner NEW_PASSWORD='...' [RESET_2FA=1] DATABASE_URL=postgres://owner:...@db/erp npm run reset-access
// Sets a new password, optionally clears 2FA, revokes every session, unlocks the account, and writes an audit entry.
import postgres from "postgres";
import { assertStrongPassword, hashPassword } from "../src/lib/auth";

const { DATABASE_URL, OWNER_USERNAME, NEW_PASSWORD, RESET_2FA } = process.env;
if (!DATABASE_URL || !OWNER_USERNAME || !NEW_PASSWORD) throw new Error("Set DATABASE_URL, OWNER_USERNAME, NEW_PASSWORD");
assertStrongPassword(NEW_PASSWORD);
const sql = postgres(DATABASE_URL, { max: 1 });
try {
  await sql.begin(async (tx) => {
    const [u] = await tx`SELECT id, company_id FROM users WHERE username = ${OWNER_USERNAME.toLowerCase()} FOR UPDATE`;
    if (!u) throw new Error("user not found");
    await tx`UPDATE users SET password_hash = ${await hashPassword(NEW_PASSWORD)}, failed_logins = 0, locked_until = NULL, status = 'ACTIVE',
        totp_enabled = CASE WHEN ${RESET_2FA === "1"} THEN false ELSE totp_enabled END, totp_secret_enc = CASE WHEN ${RESET_2FA === "1"} THEN NULL ELSE totp_secret_enc END,
        totp_last_step = CASE WHEN ${RESET_2FA === "1"} THEN NULL ELSE totp_last_step END, version = version + 1, updated_at = now() WHERE id = ${u.id}`;
    await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${u.id} AND revoked_at IS NULL`;
    await tx`INSERT INTO audit_logs(company_id, user_id, action, entity_type, entity_id, after_data, reason) VALUES (${u.company_id}, NULL, 'access.reset_by_operator', 'user', ${u.id}, ${tx.json({ twoFactorReset: RESET_2FA === "1" })}, 'server-side recovery script')`;
  });
  console.log("access reset for", OWNER_USERNAME, RESET_2FA === "1" ? "(2FA cleared — re-enrol immediately)" : "");
} finally { await sql.end(); }
