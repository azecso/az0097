// CI gate: forbids float money and cascade deletes. Fails the build with a clear message.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const bad = [];
function walk(d, f) { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p, f) : f(p); } }
walk("src", (p) => {
  if (!/\.(ts|tsx)$/.test(p)) return;
  const s = readFileSync(p, "utf8");
  for (const re of [/parseFloat\(/, /\.toFixed\(/, /Math\.round\(/]) if (re.test(s) && !s.includes("lint-money:allow")) bad.push(`${p}: ${re} on money is forbidden (use decimal.js via src/lib/money.ts)`);
});
walk("db/migrations", (p) => {
  const s = readFileSync(p, "utf8").replace(/--.*$/gm, "");
  if (/ON\s+DELETE\s+CASCADE/i.test(s)) bad.push(`${p}: ON DELETE CASCADE is forbidden`);
  if (/\b(float|real|double\s+precision|money)\b/i.test(s)) bad.push(`${p}: float/money column types are forbidden (use NUMERIC)`);
});
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
console.log("lint-money: OK");
