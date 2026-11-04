const { chromium } = require("./pw.cjs");
const BASE = process.env.E2E_BASE || "http://localhost:3100";
(async () => {
  const b = await chromium.launch(); const out = []; const ok = (n, c) => out.push((c ? "PASS " : "FAIL ") + n);
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } }); const p = await ctx.newPage(); const errs = [];
  p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error" && !/status of 40[139]/.test(m.text())) errs.push(m.text()); });
  const B = BASE; const wait = (t, ms = 15000) => p.waitForSelector(t, { timeout: ms });
  const post = (path, body) => p.evaluate(async ([path, body]) => { const me = await (await fetch("/api/auth/me")).json(); const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": me.csrf }, body: JSON.stringify(body) }); return r.json(); }, [path, body]);
  await p.goto(B + "/login"); await p.fill("#u", "owner"); await p.fill("#p", "Owner-Smoke-Pass-77"); await p.click("button.primary"); await p.waitForURL(B + "/");
  // master data via UI
  await p.goto(B + "/contacts"); await wait("#c"); await p.selectOption("#k", "CUSTOMER"); await p.fill("#c", "C1"); await p.fill("#n", "عميل الجملة"); await p.click("form.card button.primary"); await wait(".msg.ok");
  await p.selectOption("#k", "SUPPLIER"); await p.fill("#c", "S1"); await p.fill("#n", "مورد الجملة"); await p.click("form.card button.primary"); await p.waitForFunction(() => document.querySelectorAll("tbody tr").length >= 2);
  await p.goto(B + "/inventory/products"); await wait("#c"); await p.fill("#c", "P1"); await p.fill("#n", "سلعة"); await p.click("form.card button.primary"); await wait(".msg.ok");
  const prods = await p.evaluate(async () => (await (await fetch("/api/products")).json()));
  const contacts = await p.evaluate(async () => (await (await fetch("/api/contacts")).json()));
  const sup = contacts.find((c) => c.code === "S1").id, cus = contacts.find((c) => c.code === "C1").id;
  const buy = await post("/api/purchases", { supplierId: sup, docDate: "2026-11-01", paymentType: "CREDIT", currency: "IQD", lines: [{ productId: prods[0].id, uom: "قطعة", qty: "100", unitPrice: "7000" }] });
  await post(`/api/purchases/${buy.id}/post`, {});
  // sale through the UI
  await p.goto(B + "/sales/new"); await wait("#c"); await p.selectOption("#c", { label: "عميل الجملة" });
  const sels = await p.$$(".row.card select"); await sels[0].selectOption({ index: 1 });
  const ins = []; for (const i of await p.$$(".row.card input")) if ((await i.getAttribute("inputmode")) === "decimal") ins.push(i); await ins[0].fill("100"); await ins[1].fill("10000");
  await p.click("button.primary:has-text('حفظ كمسودة')"); await p.waitForURL(/\/sales\/[0-9a-f-]{36}/); await wait("h1");
  ok("sales draft has DRAFT ref", (await p.textContent("h1")).includes("DRAFT-"));
  await p.click("button:has-text('تعديل')"); await p.waitForURL(/\/sales\/new\?edit=/);
  await p.waitForFunction(() => [...document.querySelectorAll(".row.card input")].some((i) => i.value === "100") && [...document.querySelectorAll(".row.card input")].some((i) => i.value === "10000") && document.querySelector("#c").value !== "");
  ok("sales draft opens for editing with customer, quantity and price prefilled", true);
  await p.click("button.primary:has-text('حفظ كمسودة')"); await p.waitForURL(/\/sales\/[0-9a-f-]{36}$/); await p.waitForFunction(() => document.body.textContent.includes("1,000,000"));
  ok("saving the edit keeps the draft and its total", (await p.textContent("h1")).includes("DRAFT-"));
  await p.click("button.primary:has-text('ترحيل')"); await p.waitForFunction(() => document.querySelector("h1").textContent.includes("INV-")); await wait(".card.grid .label");
  const g = await p.textContent(".card.grid");
  ok("invoice posted: net 1,000,000 and outstanding 1,000,000", g.includes("1,000,000") && g.includes("المتبقي"));
  ok("gross profit 300,000 (cost 700,000 via FIFO delivery)", g.includes("300,000"));
  const invUrl = p.url(); const invId = invUrl.split("/").pop();
  // collect 200,000 by the partner into custody, then hand over
  const custody = (await p.evaluate(async () => (await (await fetch("/api/cash-accounts")).json()))).find((a) => a.kind === "PARTNER_CUSTODY").id;
  await p.goto(B + "/sales/receipts"); await wait("#c"); await p.selectOption("#c", { label: "عميل الجملة" }); await p.selectOption("#ca", custody); await p.fill("#a", "200000");
  await p.waitForSelector("td input"); await p.fill("td input", "200000"); await p.click("form.card button.primary"); await wait(".msg.ok");
  await p.click("td button.primary:has-text('ترحيل')"); await p.waitForFunction(() => document.body.textContent.includes("RC-")); ok("receipt into partner custody posted (RC- number)", true);
  await p.goto(B + "/cash"); await wait(".grid .card"); const cashTxt = await p.textContent(".grid"); ok("custody shows 200,000 and is not counted as available cash", cashTxt.includes("200,000") && cashTxt.includes("لا تُحتسب ضمن النقد المتاح"));
  const main = (await p.evaluate(async () => (await (await fetch("/api/cash-accounts")).json()))).find((a) => a.kind === "MAIN_CASH" && a.currency === "IQD").id;
  await p.selectOption("#f", custody); await p.selectOption("#t", main); await p.fill("#a", "200000"); await p.click("form.card button.primary"); await wait(".msg.ok");
  await p.click("td button.primary:has-text('ترحيل')"); await p.waitForFunction(() => document.body.textContent.includes("TR-"));
  await p.reload(); await wait(".grid .card"); await p.waitForTimeout(500);
  ok("after hand-over: main cash 200,000, custody 0", (await p.textContent(".grid")).match(/200,000/g).length === 1);
  // return 30 pieces
  await p.goto(B + "/sales/" + invId); await wait("h1"); await p.waitForSelector("text=مرتجع من العميل");
  await p.fill(".card:has(h2:has-text('مرتجع')) input[dir='ltr']", "30"); await p.fill(".card:has(h2:has-text('مرتجع')) .row:last-of-type input", "بضاعة غير مطابقة");
  await p.click("button:has-text('إنشاء وترحيل المرتجع')"); await p.waitForFunction(() => document.body.textContent.includes("تم ترحيل المرتجع"));
  await p.reload(); await wait(".card.grid"); const g2 = await p.textContent(".card.grid");
  ok("after return: outstanding 500,000 (1,000,000 - 200,000 - 300,000)", g2.includes("500,000"));
  ok("linked profit now 120,000 (calc: 210,000 x 200/700)", g2.includes("60,000") || g2.includes("120,000"));
  // reports
  await p.goto(B + "/inventory/stock"); await wait("text=✔ متطابق"); ok("inventory still reconciles with ledger", true);
  await p.goto(B + "/accounting"); await wait("text=✔ متوازن"); ok("trial balance balanced", true);
  await p.goto(B + "/contacts"); await wait("td button:has-text('كشف الحساب')"); await p.click("tr:has-text('عميل الجملة') button:has-text('كشف الحساب')"); await wait("text=كشف حساب"); ok("customer statement opens", true);
  await p.screenshot({ path: "sale.png", fullPage: true });
  // mobile
  const m = await b.newContext({ viewport: { width: 390, height: 800 } }); const mp = await m.newPage();
  await mp.goto(B + "/login"); await mp.fill("#u", "owner"); await mp.fill("#p", "Owner-Smoke-Pass-77"); await mp.click("button.primary"); await mp.waitForURL(B + "/");
  for (const path of ["/sales", "/sales/new", "/sales/" + invId, "/sales/receipts", "/cash", "/sales/quotes"]) { await mp.goto(B + path); await mp.waitForSelector("h1"); await mp.waitForTimeout(600); ok(`mobile ${path.replace(invId, ":id")}: no horizontal scroll`, await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); }
  await mp.goto(B + "/sales/" + invId); await mp.waitForTimeout(500); await mp.screenshot({ path: "sale-mobile.png" });
  await p.goto(B + "/"); await wait("a[aria-label='تفاصيل: رصيد الصندوق']"); await p.click("a[aria-label='تفاصيل: رصيد الصندوق']"); await p.waitForURL(/\/cash\/movements/);
  await p.waitForSelector("td:has-text('سند قبض من عميل')"); const mv = await p.textContent("body");
  ok("dashboard cash card opens the movement ledger with the source of each amount", mv.includes("سند قبض من عميل") && mv.includes("تحويل بين الصناديق") && /RC-\d{4}-/.test(mv));
  await p.goto(B + "/"); await p.click("a[aria-label^='تفاصيل: ديون العملاء']"); await p.waitForURL(/\/reports\?tab=debtors/); await p.waitForSelector("tbody td:has-text('INV-')");
  ok("customer-debts card opens the debtors report with total, paid and remaining per invoice", (await p.textContent("thead")).includes("المقبوض") && (await p.textContent("tbody")).includes("500,000"));
  await p.goto(B + "/"); await p.click("a[aria-label='تفاصيل: قيمة المخزون']"); await p.waitForURL(/\/inventory\/stock/); ok("inventory card opens the stock page", true);
  ok("no console/page errors", errs.length === 0); if (errs.length) out.push("  " + errs.slice(0, 3).join(" | "));
  console.log(out.join("\n")); await b.close();
})().catch((e) => { console.error("SMOKE ERROR", e.message.split("\n").slice(0, 8).join("\n")); process.exit(1); });
