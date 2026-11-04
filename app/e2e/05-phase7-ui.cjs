// Phase 7 UI: quick-create inside pickers, capital-return register (add/edit/print/delete), reports page + Excel + print.
const { chromium } = require("./pw.cjs");
let P; const BASE = process.env.E2E_BASE || "http://localhost:3100";
(async () => {
  const b = await chromium.launch(); const out = []; const ok = (n, c) => out.push((c ? "PASS " : "FAIL ") + n);
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } }); const p = await ctx.newPage(); P = p; const errs = [];
  p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error" && !/status of 40[13]/.test(m.text())) errs.push(m.text()); });
  const B = BASE; const wait = (t) => p.waitForSelector(t, { timeout: 15000 });
  p.on("dialog", (d) => { if (d.type() === "prompt") void d.accept("إدخال بالخطأ"); else void d.accept(); });
  await p.goto(B + "/login"); await p.fill("#u", "owner"); await p.fill("#p", "Owner-Smoke-Pass-77"); await p.click("button.primary"); await p.waitForURL(B + "/");

  // 1) create the supplier and the product from inside the purchase form
  await p.goto(B + "/purchases/new"); await wait("#s");
  const sup = p.locator(".pick").nth(0); await sup.locator("button:has-text('جديد')").click();
  await sup.locator("input[name=nm]").fill("مورد سريع"); await sup.locator("input[name=ph]").fill("07701234567"); await sup.locator("button:has-text('حفظ واختيار')").click();
  await p.waitForFunction(() => { const s = document.querySelector("#s"); return s && s.selectedOptions[0] && s.selectedOptions[0].textContent === "مورد سريع"; });
  ok("new supplier created inside the invoice form and auto-selected", true); await p.selectOption("#t", "CREDIT");
  const prod = p.locator(".pick").nth(1); await prod.locator("button:has-text('جديد')").click();
  await prod.locator("input[name=nm]").fill("سكر ناعم"); await prod.locator("input[name=code]").fill("SGR"); await prod.locator("button:has-text('حفظ واختيار')").click();
  await p.waitForFunction(() => [...document.querySelectorAll("select")].some((s) => s.selectedOptions[0] && s.selectedOptions[0].textContent.includes("سكر ناعم")));
  ok("new product created inside the line and auto-selected", true);
  await p.waitForFunction(() => [...document.querySelectorAll("select")].some((s) => [...s.options].some((o) => o.textContent === "قطعة")));
  ok("the new product's unit is available at once", true);
  const ins = await p.$$(".row.card input"); const nums = []; for (const i of ins) { if ((await i.getAttribute("inputmode")) === "decimal" && !(await i.getAttribute("name"))) nums.push(i); }
  await nums[0].fill("10"); await nums[1].fill("2500");
  await p.click("button.primary:has-text('حفظ كمسودة')"); await p.waitForURL(/\/purchases\/[0-9a-f-]{36}/); await wait("h1");
  await p.click("button.primary:has-text('ترحيل')"); await wait(".msg.ok"); await p.waitForFunction(() => document.querySelector("h1").textContent.includes("PO-"));
  ok("invoice with the freshly created supplier/product posts", true);

  // navigation + correction flow (list row opens document, back button, reverse+copy, edit draft, re-post)
  const detailUrl = p.url();
  await p.goto(B + "/purchases"); await wait("tbody tr.clickrow"); await p.click("tbody tr.clickrow td:nth-child(3)");
  await p.waitForURL(detailUrl); ok("clicking anywhere on a list row opens the document", true);
  await p.click("button:has-text('رجوع')"); await p.waitForURL(B + "/purchases"); ok("the back button returns one step", true);
  await p.goto(detailUrl); await wait("#rs"); await p.fill("#rs", "خطأ في الكمية"); await p.click("button:has-text('تصحيح')");
  await p.waitForURL(/\/purchases\/new\?copy=/); await p.waitForFunction(() => [...document.querySelectorAll(".row.card input")].some((i) => i.value === "10"));
  ok("correction reverses the original and opens a prefilled copy", true);
  await p.click("button.primary:has-text('حفظ كمسودة')"); await p.waitForURL(/\/purchases\/[0-9a-f-]{36}$/); await wait("h1");
  ok("the original is reversed and the copy is a new draft", (await p.textContent("h1")).includes("DRAFT-"));
  await p.click("button:has-text('تعديل')"); await p.waitForURL(/\/purchases\/new\?edit=/); await p.waitForFunction(() => [...document.querySelectorAll(".row.card input")].some((i) => i.value === "10"));
  for (const i of await p.$$(".row.card input")) if (await i.evaluate((n) => n.value === "10")) { await i.fill("12"); break; }
  await p.click("button.primary:has-text('حفظ كمسودة')"); await p.waitForURL(/\/purchases\/[0-9a-f-]{36}$/); await p.waitForFunction(() => document.body.textContent.includes("30,000"));
  ok("editing the draft saves the new quantity (12 x 2,500 = 30,000)", true);
  await p.click("button.primary:has-text('ترحيل')"); await p.waitForFunction(() => document.querySelector("h1").textContent.includes("PO-")); ok("the corrected invoice posts", true);
  await p.goto(B + "/purchases"); await wait("tfoot tr"); const lst = await p.textContent(".card");
  ok("list shows the payment state and a totals row under the amount column", lst.includes("غير مسددة") && lst.includes("المجموع") && lst.includes("30,000"));

  // 2) expense category quick-create
  await p.goto(B + "/expenses"); await wait("#c");
  const cat = p.locator(".pick").nth(0); await cat.locator("button:has-text('جديد')").click(); await cat.locator("input[name=nm]").fill("قرطاسية"); await cat.locator("button:has-text('حفظ واختيار')").click();
  await p.waitForFunction(() => { const s = document.querySelector("#c"); return s && s.selectedOptions[0] && s.selectedOptions[0].textContent === "قرطاسية"; });
  ok("expense category created in place and selected", true);

  // 3) capital-return register
  await p.goto(B + "/capital/returns"); await wait("#amount");
  ok("page states it does not affect the accounts", (await p.textContent("body")).includes("لا يؤثر على الحسابات الداخلية"));
  await p.fill("#amount", "1500000"); await p.fill("#who", "صاحب المال"); await p.fill("#ref", "R-1001"); await p.fill("#note", "دفعة");
  await p.click("form.card button.primary"); await wait(".msg.ok"); await p.waitForSelector("td:has-text('R-1001')");
  const row1 = await p.textContent("tbody"); ok("register shows number CR-, recipient, receipt no., amount and a time", /CR-\d{4}-000001/.test(row1) && row1.includes("صاحب المال") && row1.includes("1,500,000") && /\d{2}:\d{2}/.test(row1));
  ok("total per currency shown", (await p.textContent(".grid")).includes("1,500,000"));
  await p.click("tbody button:has-text('تعديل')"); await p.fill("#amount", "1600000"); await p.click("form.card button.primary:has-text('حفظ التعديل')"); await wait(".msg.ok");
  await p.waitForFunction(() => document.querySelector("tbody").textContent.includes("1,600,000")); ok("edit saved", true);
  const [pr] = await Promise.all([ctx.waitForEvent("page"), p.click("tbody a:has-text('طباعة')")]);
  await pr.waitForSelector("[data-ready]", { timeout: 15000 }); const pt = await pr.textContent("body");
  ok("print voucher shows recipient, receipt no. and amount in words", pt.includes("صاحب المال") && pt.includes("R-1001") && pt.includes("مليون")); await pr.close();
  await p.click("tbody button:has-text('حذف')"); await p.waitForFunction(() => !document.querySelector("tbody").textContent.includes("R-1001")); ok("delete (with reason) removes the row", true);
  const tb = await (await ctx.request.get(B + "/api/reports/trial-balance")).json(); ok("ledger untouched and balanced after register changes", tb.balanced === true && !tb.rows.some((r) => r.code === "3100" && Number(r.debit) > 0));

  // 4) reports page, Excel, print
  await p.goto(B + "/reports"); await wait("#g"); await p.click("button[role=tab]:has-text('تقرير المشتريات')"); await p.selectOption("#g", "product");
  await p.waitForSelector("tbody td:has-text('SGR')"); const rep = await p.textContent("tbody");
  ok("purchases report by product shows the item with its value", rep.includes("سكر ناعم") && rep.includes("30,000"));
  const x = await ctx.request.get(B + "/api/export/purchases-report?group=product"); ok("Excel export of the filtered report downloads", x.status() === 200 && (x.headers()["content-type"] || "").includes("spreadsheet"));
  const [rp] = await Promise.all([ctx.waitForEvent("page"), p.click("a:has-text('طباعة')")]); await rp.waitForSelector("[data-ready]", { timeout: 15000 });
  ok("print page renders the same report", (await rp.textContent("body")).includes("تقرير المشتريات") && (await rp.textContent("body")).includes("SGR")); await rp.close();
  await p.click("button[role=tab]:has-text('الدائنون')"); await p.check("text=ملخص لكل جهة"); await p.waitForSelector("tbody td:has-text('مورد سريع')"); ok("creditors summary lists the new supplier with the balance", true);
  await p.click("button[role=tab]:has-text('حركة صنف')"); await p.selectOption("#m", { index: 1 }); await p.waitForSelector("tbody td:has-text('PURCHASE_IN')"); ok("item movement shows the purchase receipt", true);
  for (const path of ["/reports", "/capital/returns"]) { await p.setViewportSize({ width: 390, height: 800 }); await p.goto(B + path); await wait("h1"); ok("mobile " + path + ": no horizontal scroll", await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); }
  ok("no console/page errors", errs.length === 0); if (errs.length) out.push("ERRORS: " + errs.slice(0, 5).join(" | "));
  console.log(out.join("\n")); await b.close();
})().catch(async (e) => { console.log("SMOKE ERROR " + e.message); try { await P.screenshot({ path: "fail05.png", fullPage: true }); console.log("URL " + P.url() + "\n" + (await P.textContent("body")).slice(0, 600)); } catch {} process.exit(1); });
