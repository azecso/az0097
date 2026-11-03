// Start for managed hosts (no Docker): migrate with the owner URL, then run the app with the restricted role.
// Env: DATABASE_URL (owner/admin URL given by the host), APP_DB_PASSWORD, APP_SECRET, PORT.
import { spawnSync, spawn } from "node:child_process";
const admin = process.env.DATABASE_URL, pw = process.env.APP_DB_PASSWORD;
if (!admin || !pw || !process.env.APP_SECRET) { console.error("DATABASE_URL, APP_DB_PASSWORD, APP_SECRET are required"); process.exit(1); }
const appUser = process.env.APP_DB_USER || "erp_app";
const run = (cmd, args, env) => spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
if (run("npx", ["tsx", "scripts/migrate.ts"], { APP_DB_USER: appUser, APP_DB_PASSWORD: pw }).status !== 0) process.exit(1);
if (process.env.COMPANY_NAME && process.env.OWNER_USERNAME && process.env.OWNER_PASSWORD) {
  // idempotent first-time setup; bootstrap refuses/skips when a company already exists
  run("npx", ["tsx", "scripts/bootstrap.ts"], {});
}
const u = new URL(admin); u.username = appUser; u.password = pw;
const srv = spawn("node", ["node_modules/next/dist/bin/next", "start", "-p", process.env.PORT || "3000"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: u.toString(), OWNER_PASSWORD: "" } });
srv.on("exit", (c) => process.exit(c ?? 1));
