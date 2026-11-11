// Start for managed hosts (no Docker): migrate with the owner URL, then run the app with the restricted role.
// Env: DATABASE_URL (owner/admin URL given by the host), APP_DB_PASSWORD, APP_SECRET, PORT.
import { spawnSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
const admin = process.env.DATABASE_URL, pw = process.env.APP_DB_PASSWORD;
if (!admin || !pw || !process.env.APP_SECRET) { console.error("DATABASE_URL, APP_DB_PASSWORD, APP_SECRET are required"); process.exit(1); }
const appUser = process.env.APP_DB_USER || "erp_app";
// In-system data reset without manual setup: a dedicated database role that can ONLY execute reset_company_data (never the app role, never the owner) is created at migration time with a
// password derived from APP_SECRET, and the app is given a connection URL for it. Set RESET_DB_USER/RESET_DB_PASSWORD/RESET_DATABASE_URL yourself to override; RESET_DISABLED=1 turns it off.
const resetUser = process.env.RESET_DB_USER || "erp_reset";
const resetPw = process.env.RESET_DB_PASSWORD || createHmac("sha256", process.env.APP_SECRET).update("erp-reset-role").digest("hex").slice(0, 40);
const resetOn = process.env.RESET_DISABLED !== "1";
const run = (cmd, args, env) => spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
if (run("npx", ["tsx", "scripts/migrate.ts"], { APP_DB_USER: appUser, APP_DB_PASSWORD: pw, ...(resetOn ? { RESET_DB_USER: resetUser, RESET_DB_PASSWORD: resetPw } : {}) }).status !== 0) process.exit(1);
if (process.env.COMPANY_NAME && process.env.OWNER_USERNAME && process.env.OWNER_PASSWORD) {
  // idempotent first-time setup; bootstrap refuses/skips when a company already exists
  run("npx", ["tsx", "scripts/bootstrap.ts"], {});
}
const u = new URL(admin); u.username = appUser; u.password = pw;
const ru = new URL(admin); ru.username = resetUser; ru.password = resetPw;
const srv = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", process.env.PORT || "3000"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: u.toString(), OWNER_PASSWORD: "", RESET_DB_PASSWORD: "", ...(resetOn ? { RESET_DATABASE_URL: process.env.RESET_DATABASE_URL || ru.toString(), EXPORT_DIR: process.env.EXPORT_DIR || "/tmp/erp-exports" } : {}) } });
srv.on("exit", (c) => process.exit(c ?? 1));
