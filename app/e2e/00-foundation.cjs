const { chromium } = require("./pw.cjs");
const BASE = process.env.E2E_BASE || "http://localhost:3100";
(async () => {
  const b = await chromium.launch(); const out = [];
  const ok = (n, c) => { out.push((c ? "PASS " : "FAIL ") + n); };
  const ctx = await b.newContext({ viewport: { width: 1200, height: 800 } }); const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error" && !/status of 40[13]/.test(m.text())) errs.push(m.text()); });
  await p.goto(BASE + "/");
  await p.waitForURL("**/login"); ok("unauthenticated visit redirects to /login", true);
  ok("html is lang=ar dir=rtl", (await p.getAttribute("html", "dir")) === "rtl" && (await p.getAttribute("html", "lang")) === "ar");
  await p.fill("#u", "owner"); await p.fill("#p", "wrong-password-1"); await p.click("button.primary");
  await p.waitForSelector(".msg.err"); ok("wrong password shows Arabic error", true);
  await p.fill("#p", "Owner-Smoke-Pass-77"); await p.click("button.primary"); await p.waitForURL(BASE + "/");
  await p.waitForSelector("h1"); ok("dashboard after login", (await p.textContent("h1")).includes("لوحة التحكم"));
  const cards = await p.$$eval(".stat .value", (e) => e.map((x) => x.textContent.trim()));
  ok("dashboard shows NO fake financial numbers", cards.every((c) => c === "—"));
  const cookies = await ctx.cookies(); const ck = cookies.find((c) => c.name === "erp_session");
  ok("session cookie HttpOnly + Lax", ck.httpOnly && ck.sameSite === "Lax");
  await p.screenshot({ path: "dash-desktop.png" });
  // create accountant
  await p.goto(BASE + "/settings/users"); await p.waitForSelector("#un");
  await p.fill("#un", "acc"); await p.fill("#dn", "المحاسب"); await p.fill("#pw", "Accountant-Smoke-88"); await p.click("form.card button.primary");
  await p.waitForSelector(".msg.ok"); ok("owner creates accountant", true);
  await p.click("td button:has-text(\"الصلاحيات\")"); await p.waitForSelector("text=صلاحيات المحاسب");
  await p.waitForSelector("td span[title]"); const locks = await p.$$eval("td span[title]", (e) => e.length); ok("owner-only permissions render as locked (🔒)", locks > 5);
  await p.screenshot({ path: "users-desktop.png", fullPage: true });
  // fx rate
  await p.goto(BASE + "/settings/fx"); await p.waitForSelector("#r"); await p.fill("#r", "1480.5"); await p.click("form.card button.primary");
  await p.waitForSelector(".msg.ok"); await p.waitForSelector("text=1480.50000000"); ok("fx rate saved + exact decimal shown", true);
  await p.click("text=خروج"); await p.waitForURL("**/login");
  // accountant view
  await p.fill("#u", "acc"); await p.fill("#p", "Accountant-Smoke-88"); await p.click("button.primary"); await p.waitForURL(BASE + "/");
  const nav = await p.$$eval(".side a", (e) => e.map((x) => x.textContent));
  ok("accountant nav hides users/audit", !nav.some((t) => t.includes("المستخدمون")) && !nav.some((t) => t.includes("التدقيق")));
  const r = await p.evaluate(async () => (await fetch("/api/users")).status); ok("accountant GET /api/users => 403", r === 403);
  await p.goto(BASE + "/settings/company"); await p.waitForSelector("text=للمالك فقط"); ok("company form read-only for accountant", await p.isDisabled("#n"));
  // mobile
  const m = await b.newContext({ viewport: { width: 390, height: 800 } }); const mp = await m.newPage();
  await mp.goto(BASE + "/login"); await mp.fill("#u", "acc"); await mp.fill("#p", "Accountant-Smoke-88"); await mp.click("button.primary"); await mp.waitForURL(BASE + "/");
  await mp.waitForSelector(".tabbar"); const sw = await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  ok("mobile: bottom tab bar visible, no horizontal scroll", (await mp.isVisible(".tabbar")) && sw);
  await mp.screenshot({ path: "dash-mobile.png" });
  ok("no browser console/page errors", errs.length === 0); if (errs.length) out.push("  " + errs.slice(0, 3).join(" | "));
  console.log(out.join("\n")); await b.close();
})().catch((e) => { console.error("SMOKE ERROR", e); process.exit(1); });
