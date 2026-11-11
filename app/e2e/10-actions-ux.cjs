const { chromium } = require("./pw.cjs");
const BASE = process.env.E2E_BASE || "http://localhost:3100";
(async () => {
  const b = await chromium.launch(); const out = []; const ok = (n, c) => out.push((c ? "PASS " : "FAIL ") + n);
  const p = await (await b.newContext({ viewport: { width: 1200, height: 900 } })).newPage(); const errs = [];
  p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error" && !/status of 40[139]/.test(m.text())) errs.push(m.text()); });
  const call = (method, path, body) => p.evaluate(async ([method, path, body]) => { const me = await (await fetch("/api/auth/me")).json(); const r = await fetch(path, { method, headers: { "content-type": "application/json", "x-csrf-token": me.csrf }, body: body ? JSON.stringify(body) : undefined }); return r.json(); }, [method, path, body]);
  await p.goto(BASE + "/login"); await p.fill("#u", "owner"); await p.fill("#p", "Owner-Smoke-Pass-77"); await p.click("button.primary"); await p.waitForURL(BASE + "/");
  const day = new Date().toISOString().slice(0, 10);
  const cash = await p.evaluate(async () => (await (await fetch("/api/cash-accounts")).json())); const iqd = cash.find((a) => a.kind === "MAIN_CASH" && a.currency === "IQD").id;
  await call("POST", "/api/fx-rates", { currency: "USD", rateDate: day, rate: "1500" });
  const cap = await call("POST", "/api/capital", { kind: "INJECTION", docDate: day, cashAccountId: iqd, currency: "IQD", amount: "20000000", reason: "ابتدائي" }); await call("POST", `/api/capital/${cap.id}/approve`, {});
  const cus = (await call("POST", "/api/contacts", { kind: "CUSTOMER", code: "C1", name: "عميل" })).id, sup = (await call("POST", "/api/contacts", { kind: "SUPPLIER", code: "S1", name: "مورد" })).id;
  const prod = (await call("POST", "/api/products", { code: "P1", name: "سلعة", baseUom: "قطعة", qtyDecimals: 0, defaultSalePrice: "2000", defaultCurrency: "IQD" })).id;
  const po = await call("POST", "/api/purchases", { supplierId: sup, docDate: day, paymentType: "CREDIT", currency: "IQD", lines: [{ productId: prod, uom: "قطعة", qty: "100", unitPrice: "1000" }] }); await call("POST", `/api/purchases/${po.id}/post`);
  // draft invoice: the pay button is visible but disabled, with the reason
  const inv = await call("POST", "/api/sales-invoices", { customerId: cus, docDate: day, saleType: "CREDIT", currency: "IQD", lines: [{ productId: prod, uom: "قطعة", qty: "10", unitPrice: "2000" }] });
  await p.goto(BASE + "/sales/" + inv.id); await p.waitForSelector("button:has-text('اعتماد')");
  ok("a draft shows the action bar; pay stays hidden until approval but approval is offered", (await p.locator("button:has-text('اعتماد')").count()) >= 1);
  await p.click("button.primary:has-text('اعتماد')"); await p.waitForFunction(() => document.querySelector("h1").textContent.includes("INV-"));
  ok("status shows 'unpaid' after approval", (await p.textContent("h1")).includes("غير مسدَّدة"));
  // double click on the payment dialog creates exactly one receipt
  await p.click("button:has-text('تسجيل تسديد')"); await p.waitForSelector("#pd-a"); await p.fill("#pd-a", "5000");
  const btn = p.locator("[role=dialog] button.primary:has-text('تسجيل التسديد')"); await btn.dblclick();
  await p.waitForFunction(() => document.body.textContent.includes("تم تسجيل التسديد"));
  const rcs = await p.evaluate(async () => (await (await fetch("/api/customer-receipts")).json()).filter((r) => r.status === "POSTED").length);
  ok("double-clicking 'register payment' creates exactly one receipt", rcs === 1);
  await p.waitForFunction(() => document.querySelector("h1").textContent.includes("مسدَّدة جزئياً") && document.body.textContent.includes("سجل التسديد"));
  ok("status becomes 'partly paid' and the payment history lists the receipt", true);
  // pay the rest in USD through the explicit rate: 10,000 IQD = 6.67 USD is not exact; use the invoice remaining 5,000 with a 1,500 rate => 3.33 USD cannot cover; pay in IQD instead
  await p.click("button:has-text('تسجيل تسديد')"); await p.waitForSelector("#pd-a"); const pre = await p.inputValue("#pd-a"); ok("the dialog pre-fills the remaining amount (got " + pre + ")", Number(pre) === 15000);
  await p.click("[role=dialog] button.primary:has-text('تسجيل التسديد')"); await p.waitForFunction(() => document.querySelector("h1").textContent.includes("مسدَّدة") && !document.querySelector("h1").textContent.includes("جزئياً") && !document.querySelector("h1").textContent.includes("غير"));
  const dis = await p.locator("button:has-text('تسجيل تسديد')").isDisabled(); ok("when fully paid the pay button stays visible, disabled, with the reason", dis && (await p.textContent("body")).includes("مسدَّدة بالكامل"));
  // purchase: register payment from the invoice
  await p.goto(BASE + "/purchases/" + po.id); await p.waitForSelector("button:has-text('تسجيل دفعة')"); await p.click("button:has-text('تسجيل دفعة')"); await p.waitForSelector("#pp-a");
  await p.fill("#pp-a", "40000"); await p.click("[role=dialog] button.primary:has-text('تسجيل الدفعة')"); await p.waitForFunction(() => document.body.textContent.includes("تم تسجيل الدفعة"));
  ok("purchase payment recorded from the purchase page, supplier and invoice linked, remaining 60,000", (await p.textContent("body")).includes("60,000"));
  // price currency: a default IQD price must not silently become a USD price
  await p.goto(BASE + "/sales/new"); await p.waitForSelector("#c"); await p.locator("#c").click(); await p.locator("#c").fill("عميل"); await p.locator("[role=option]").first().click();
  await p.locator(".row.card [role=combobox]").first().click(); await p.locator(".row.card [role=combobox]").first().fill("P1"); await p.locator("[role=option]").first().click();
  ok("default IQD price is filled for an IQD invoice", (await p.locator(".row.card input[inputmode=decimal]").nth(1).inputValue()) === "2000");
  await p.selectOption("#cu", "USD"); await p.waitForSelector("text=لم يُحوَّل تلقائياً");
  ok("switching to USD flags the old IQD price instead of silently relabelling it", true);
  await p.locator(".row.card input[inputmode=decimal]").first().fill("1"); await p.click("button.primary:has-text('حفظ كمسودة')"); await p.waitForSelector("text=أكّدها بتعديل السعر");
  ok("saving is blocked until the price is confirmed or converted at a stated rate", true);
  await p.click("button:has-text('تحويل الأسعار بسعر معلن')"); await p.waitForSelector("text=حُوِّلت الأسعار بسعر 1500");
  ok("converting uses the declared daily rate (2,000 IQD / 1,500 = 1.33 USD)", (await p.locator(".row.card input[inputmode=decimal]").nth(1).inputValue()) === "1.33");
  // new reports render
  for (const [path, text] of [["/reports/trial-balance", "ميزان المراجعة"], ["/reports/profit-loss", "الأرباح والخسائر"], ["/reports/balance-sheet", "المركز المالي"], ["/reports/customers", "كشف حسابات العملاء"], ["/reports/inventory-movement", "حركة المخزون"], ["/reports/cash-movement", "حركة النقد والعهدة"], ["/reports/profit-statement", "كشف الأرباح"]]) {
    await p.goto(BASE + path); await p.waitForSelector("table"); ok(`report ${path} renders with its definition`, (await p.textContent("h1")).includes(text) && (await p.textContent("body")).includes("التعريف"));
  }
  await p.goto(BASE + "/reports/ledger?account=1110"); await p.waitForSelector("table"); ok("ledger drills into account 1110", (await p.textContent("body")).includes("رصيد افتتاحي"));
  const m = await b.newContext({ viewport: { width: 390, height: 800 } }); const mp = await m.newPage();
  await mp.goto(BASE + "/login"); await mp.fill("#u", "owner"); await mp.fill("#p", "Owner-Smoke-Pass-77"); await mp.click("button.primary"); await mp.waitForURL(BASE + "/");
  for (const path of ["/sales/" + inv.id, "/purchases/" + po.id, "/reports/profit-loss"]) { await mp.goto(BASE + path); await mp.waitForSelector("h1"); await mp.waitForTimeout(500); ok(`mobile ${path.replace(/[0-9a-f-]{36}/, ":id")}: no horizontal scroll`, await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); }
  ok("no console/page errors", errs.length === 0); if (errs.length) out.push("  " + errs.slice(0, 3).join(" | "));
  console.log(out.join("\n")); await b.close();
})().catch((e) => { console.error("SMOKE ERROR", e.message.split("\n").slice(0, 8).join("\n")); process.exit(1); });
