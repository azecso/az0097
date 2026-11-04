const { chromium } = require("./pw.cjs");
const BASE = process.env.E2E_BASE || "http://localhost:3100";
(async () => {
  const b = await chromium.launch(); const out = []; const ok = (n, c) => out.push((c ? "PASS " : "FAIL ") + n);
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } }); const p = await ctx.newPage(); const errs = [];
  p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error" && !/status of 40[139]/.test(m.text())) errs.push(m.text()); });
  const B = BASE; const wait = (t, ms = 15000) => p.waitForSelector(t, { timeout: ms });
  const call = (method, path, body) => p.evaluate(async ([method, path, body]) => { const me = await (await fetch("/api/auth/me")).json(); const r = await fetch(path, { method, headers: { "content-type": "application/json", "x-csrf-token": me.csrf }, body: body ? JSON.stringify(body) : undefined }); return r.json(); }, [method, path, body]);
  await p.goto(B + "/login"); await p.fill("#u", "owner"); await p.fill("#p", "Owner-Smoke-Pass-77"); await p.click("button.primary"); await p.waitForURL(B + "/");
  // capital through the UI: request then approve
  await p.goto(B + "/capital"); await wait("#a"); await p.fill("#a", "10000000"); await p.fill("#r", "رأس مال ابتدائي"); await p.click("form.card:has(#k) button.primary"); await wait(".msg.ok");
  await p.click("td button.primary:has-text('اعتماد')"); await p.waitForFunction(() => document.body.textContent.includes("CP-")); await p.reload(); await wait(".grid .value");
  await p.waitForFunction(() => document.querySelector(".grid").textContent.includes("10,000,000"), null, { timeout: 15000 }).catch(() => {});
  ok("capital 10,000,000 requested and approved by the owner", (await p.textContent(".grid")).includes("10,000,000"));
  // expense (accrued) through UI
  await p.goto(B + "/expenses"); await wait("#a"); await p.fill("#de", "إيجار المكتب"); await p.fill("#a", "250000"); await p.selectOption("#c", { index: 1 }); await p.selectOption("#m", "ACCRUED"); await p.click("form.card button.primary"); await wait(".msg.ok");
  await p.click("td button.primary:has-text('ترحيل')"); await p.waitForFunction(() => document.body.textContent.includes("EX-")); ok("accrued expense posted (EX- number)", true);
  await p.waitForSelector("td input[aria-label='مبلغ السداد']"); await p.fill("td input[aria-label='مبلغ السداد']", "100000"); await p.click("td button:has-text('سداد')"); await p.waitForFunction(() => document.body.textContent.includes("تم السداد"));
  await p.reload(); await p.waitForFunction(() => document.body.textContent.includes("150,000"), null, { timeout: 15000 }).catch(() => {}); ok("partial settlement leaves 150,000 due", (await p.textContent("tbody")).includes("150,000"));
  // payroll
  await p.goto(B + "/payroll"); await wait("#n"); await p.fill("#n", "موظف المبيعات"); await p.fill("#s", "400000"); await p.click("form.card button.primary"); await wait(".msg.ok");
  await p.click("button:has-text('توليد استحقاقات الشهر')"); await p.waitForSelector("td button:has-text('ترحيل الاستحقاق')"); await p.click("td button:has-text('ترحيل الاستحقاق')"); await p.waitForSelector("td button:has-text('دفع')");
  ok("salary accrued as expense (liability shown) before any payment", (await p.textContent("tbody:last-of-type")).includes("400,000"));
  // sale + collection via API then partner preview in UI
  const sup = (await call("POST", "/api/contacts", { kind: "SUPPLIER", code: "S1", name: "مورد" })).id, cus = (await call("POST", "/api/contacts", { kind: "CUSTOMER", code: "C1", name: "عميل" })).id;
  const prod = (await call("POST", "/api/products", { code: "P1", name: "سلعة", baseUom: "قطعة", qtyDecimals: 0 })).id;
  const day = new Date().toISOString().slice(0, 10), y = day.slice(0, 4);
  const cashIqd = (await (await p.evaluate(async () => (await (await fetch("/api/cash-accounts")).json())))).find((a) => a.kind === "MAIN_CASH" && a.currency === "IQD").id;
  const po = await call("POST", "/api/purchases", { supplierId: sup, docDate: day, paymentType: "CASH", cashAccountId: cashIqd, currency: "IQD", lines: [{ productId: prod, uom: "قطعة", qty: "100", unitPrice: "7000" }] }); await call("POST", `/api/purchases/${po.id}/post`);
  const inv = await call("POST", "/api/sales-invoices", { customerId: cus, docDate: day, saleType: "CREDIT", currency: "IQD", lines: [{ productId: prod, uom: "قطعة", qty: "100", unitPrice: "10000" }] }); await call("POST", `/api/sales-invoices/${inv.id}/post`);
  const rc = await call("POST", "/api/customer-receipts", { customerId: cus, docDate: day, cashAccountId: cashIqd, currency: "IQD", amount: "1000000", allocations: [{ invoiceId: inv.id, amount: "1000000" }] }); await call("POST", `/api/customer-receipts/${rc.id}/post`);
  await p.goto(B + "/partners"); await wait("#ps"); await p.fill("#ps", `${y}-01-01`); await p.fill("#pe", day); await p.click("button:has-text('معاينة')"); await wait("text=نتيجة الفترة");
  const pvTxt = await p.textContent(".card:has(#ps)");
  ok("preview: eligible 300,000 − accrued expenses 250,000+400,000? shown with distributable 0 and loss carried", pvTxt.includes("300,000") && pvTxt.includes("650,000"));
  ok("preview explains the loss carried to the next period", pvTxt.includes("350,000"));
  await p.click("button:has-text('حفظ كمسودة')"); await wait(".msg.ok"); ok("settlement draft saved", true);
  await p.screenshot({ path: "partners.png", fullPage: true });
  // opening + periods + security pages load
  for (const [path, text] of [["/accounting/opening", "الأرصدة الافتتاحية"], ["/accounting/periods", "إقفال الفترات"], ["/settings/security", "المصادقة الثنائية"]]) { await p.goto(B + path); await wait("h1"); ok(`page ${path} renders`, (await p.textContent("h1")).includes(text)); }
  // owner-only protection through the API as an accountant
  await call("POST", "/api/users", { username: "acc", displayName: "المحاسب", password: "Accountant-Smoke-88" });
  const m = await b.newContext({ viewport: { width: 390, height: 800 } }); const mp = await m.newPage();
  await mp.goto(B + "/login"); await mp.fill("#u", "acc"); await mp.fill("#p", "Accountant-Smoke-88"); await mp.click("button.primary"); await mp.waitForURL(B + "/");
  const r = await mp.evaluate(async () => { const me = await (await fetch("/api/auth/me")).json(); const x = await fetch("/api/capital/00000000-0000-0000-0000-000000000000/approve", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": me.csrf }, body: "{}" }); return x.status; });
  ok("accountant approving capital => 403", r === 403);
  const nav = await mp.$$eval(".tabbar a, .side a", (e) => e.map((x) => x.textContent)); ok("accountant never sees the 2FA/users menu", !nav.some((t) => t.includes("الأمان")));
  for (const path of ["/expenses", "/capital", "/partners", "/payroll"]) { await mp.goto(B + path); await mp.waitForSelector("h1"); await mp.waitForTimeout(500); ok(`mobile ${path}: no horizontal scroll`, await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); }
  ok("no console/page errors", errs.length === 0); if (errs.length) out.push("  " + errs.slice(0, 3).join(" | "));
  console.log(out.join("\n")); await b.close();
})().catch((e) => { console.error("SMOKE ERROR", e.message.split("\n").slice(0, 8).join("\n")); process.exit(1); });
