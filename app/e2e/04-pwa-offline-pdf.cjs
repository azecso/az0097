const { chromium } = require("./pw.cjs"); const fs = require("fs"); const { execSync } = require("child_process");
const BASE = process.env.E2E_BASE || "http://localhost:3100";
const B = BASE, PIN = "482913";
(async () => {
  const b = await chromium.launch(); const out = []; const ok = (n, c) => { const l = (c ? "PASS " : "FAIL ") + n; out.push(l); console.log(l); };
  const errs = [];
  const mkDevice = async (name) => {
    const ctx = await b.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true, serviceWorkers: "allow" }); const p = await ctx.newPage();
    p.on("pageerror", (e) => errs.push(name + ": " + e.message)); p.on("console", (m) => { if (m.type() === "error" && !/status of 40[139]|Failed to load resource|net::ERR|Failed to fetch RSC payload/.test(m.text())) errs.push(name + ": " + m.text()); });
    await p.goto(B + "/login"); await p.fill("#u", "owner"); await p.fill("#p", "Owner-Smoke-Pass-77"); await p.click("button.primary"); await p.waitForURL(B + "/");
    return { ctx, p, name };
  };
  const call = (p, method, path, body) => p.evaluate(async ([method, path, body]) => { const me = await (await fetch("/api/auth/me")).json(); const r = await fetch(path, { method, headers: { "content-type": "application/json", "x-csrf-token": me.csrf }, body: body ? JSON.stringify(body) : undefined }); return r.json(); }, [method, path, body]);
  const wait = (p, sel, ms = 20000) => p.waitForSelector(sel, { timeout: ms });

  const A = await mkDevice("A"); 
  // master data (online)
  const sup = (await call(A.p, "POST", "/api/contacts", { kind: "SUPPLIER", code: "S1", name: "مورد الجملة" })).id;
  const cus = (await call(A.p, "POST", "/api/contacts", { kind: "CUSTOMER", code: "C1", name: "عميل سري الاسم" })).id;
  const prod = (await call(A.p, "POST", "/api/products", { code: "P1", name: "سلعة حساسة الاسم", baseUom: "قطعة", qtyDecimals: 0, defaultSalePrice: "3000" })).id;
  const po = await call(A.p, "POST", "/api/purchases", { supplierId: sup, docDate: "2026-11-01", paymentType: "CREDIT", currency: "IQD", lines: [{ productId: prod, uom: "قطعة", qty: "10", unitPrice: "1000" }] }); await call(A.p, "POST", `/api/purchases/${po.id}/post`);

  // ---- PWA basics
  const man = await (await A.p.request.get(B + "/manifest.webmanifest")).json();
  ok("manifest: Arabic RTL standalone with 3 icons incl. maskable", man.lang === "ar" && man.dir === "rtl" && man.display === "standalone" && man.icons.length === 3 && man.icons.some((i) => i.purpose === "maskable"));
  ok("icons are served", (await A.p.request.get(B + "/icons/icon-512.png")).status() === 200);
  await A.p.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true), null, { timeout: 15000 });
  await A.p.evaluate(() => navigator.serviceWorker.ready);

  // ---- vault + reference cache + encryption at rest
  await A.p.goto(B + "/sync"); await wait(A.p, "#p1"); await A.p.fill("#p1", PIN); await A.p.fill("#p2", PIN); await A.p.click("button:has-text('تفعيل القفل')"); await A.p.waitForSelector("text=فُعّل القفل المحلي");
  await A.p.waitForFunction(() => new Promise((r) => { const q = indexedDB.open("erp-offline"); q.onsuccess = () => { const t = q.result.transaction("ref").objectStore("ref").get("snapshot"); t.onsuccess = () => r(!!t.result); }; }), null, { timeout: 15000 });
  const rawRef = await A.p.evaluate(() => new Promise((r) => { const q = indexedDB.open("erp-offline"); q.onsuccess = () => { const t = q.result.transaction("ref").objectStore("ref").get("snapshot"); t.onsuccess = () => r(JSON.stringify(t.result)); }; }));
  ok("cached reference data is sealed: no product/customer names in IndexedDB", !rawRef.includes("سلعة") && !rawRef.includes("عميل سري") && rawRef.includes("iv"));
  await A.p.evaluate(() => navigator.serviceWorker.ready.then((r) => r.active.postMessage({ type: "WARM" }))); await A.p.waitForTimeout(6000);
  const cached = await A.p.evaluate(async () => { const c = await caches.open("erp-shell-v1"); return (await c.keys()).map((r) => new URL(r.url).pathname); });
  ok("service worker pre-warmed the offline routes", cached.includes("/sales/new") && cached.includes("/sync") && cached.includes("/offline"));
  const apiCached = await A.p.evaluate(async () => { for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) if (new URL(r.url).pathname.startsWith("/api/")) return true; return false; });
  ok("no /api response is ever cached by the service worker", !apiCached);

  // ---- device A: offline sale
  await A.p.goto(B + "/sales/new"); await wait(A.p, "#c");
  await A.ctx.setOffline(true);
  await A.p.reload({ waitUntil: "domcontentloaded" }); await wait(A.p, "text=فاتورة بيع جديدة");
  ok("offline: the new-invoice page opens from the cache", true);
  await wait(A.p, "text=القفل المحلي مغلق"); await A.p.fill("input[aria-label='الرقم السري للقفل المحلي']", PIN); await A.p.click("button:has-text('فتح')"); await A.p.waitForSelector("#c option:has-text('عميل سري الاسم')", { state: "attached", timeout: 15000 });
  ok("offline: customers/products come from the encrypted local cache after unlock", true);
  await A.p.selectOption("#c", { label: "عميل سري الاسم" }); const sels = await A.p.$$(".row.card select"); await sels[0].selectOption({ index: 1 });
  const ins = []; for (const i of await A.p.$$(".row.card input")) if ((await i.getAttribute("inputmode")) === "decimal") ins.push(i); await ins[0].fill("8"); await ins[1].fill("3000");
  await A.p.click("button.primary:has-text('حفظ كمسودة')"); await A.p.waitForSelector("text=حُفظت على جهازك مشفّرة"); await A.p.goto(B + "/sync", { waitUntil: "domcontentloaded" }); await wait(A.p, "text=القفل المحلي مغلق"); await A.p.fill("input[aria-label='الرقم السري للقفل المحلي']", PIN); await A.p.click("button:has-text('فتح')"); await wait(A.p, "td:has-text('بانتظار المزامنة')");
  ok("offline sale saved on the device as 'pending sync' (no final number)", (await A.p.textContent("tbody")).includes("بانتظار المزامنة") && !(await A.p.textContent("tbody")).includes("INV-"));
  ok("status bar shows offline mode and 1 pending", (await A.p.textContent(".status")).includes("غير متصل") && (await A.p.textContent(".status")).includes("1 بانتظار"));
  const rawDoc = await A.p.evaluate(() => new Promise((r) => { const q = indexedDB.open("erp-offline"); q.onsuccess = () => { const t = q.result.transaction("docs").objectStore("docs").getAll(); t.onsuccess = () => r(JSON.stringify(t.result)); }; }));
  ok("the offline draft is sealed: no customer name, quantities or prices in plain text", !rawDoc.includes("عميل سري") && !rawDoc.includes("3000") && rawDoc.includes("CREATE_DRAFT"));

  // ---- device B (another phone): the same stock sold offline too
  const Bd = await mkDevice("B");
  await Bd.p.goto(B + "/sync"); await wait(Bd.p, "#p1"); await Bd.p.fill("#p1", PIN); await Bd.p.fill("#p2", PIN); await Bd.p.click("button:has-text('تفعيل القفل')"); await Bd.p.waitForSelector("text=فُعّل القفل المحلي");
  await Bd.p.waitForTimeout(1500); await Bd.p.evaluate(() => navigator.serviceWorker.ready.then((r) => r.active.postMessage({ type: "WARM" }))); await Bd.p.waitForTimeout(6000);
  await Bd.p.goto(B + "/sales/new"); await wait(Bd.p, "#c"); await Bd.ctx.setOffline(true); await Bd.p.reload({ waitUntil: "domcontentloaded" }); await wait(Bd.p, "text=القفل المحلي مغلق");
  await Bd.p.fill("input[aria-label='الرقم السري للقفل المحلي']", PIN); await Bd.p.click("button:has-text('فتح')"); await Bd.p.waitForSelector("#c option:has-text('عميل سري الاسم')", { state: "attached", timeout: 15000 });
  await Bd.p.selectOption("#c", { label: "عميل سري الاسم" }); const sb = await Bd.p.$$(".row.card select"); await sb[0].selectOption({ index: 1 });
  const ib = []; for (const i of await Bd.p.$$(".row.card input")) if ((await i.getAttribute("inputmode")) === "decimal") ib.push(i); await ib[0].fill("8"); await ib[1].fill("3000"); await Bd.p.click("button.primary:has-text('حفظ كمسودة')"); await Bd.p.waitForSelector("text=حُفظت على جهازك مشفّرة"); await Bd.p.goto(B + "/sync", { waitUntil: "domcontentloaded" }); await wait(Bd.p, "text=القفل المحلي مغلق"); await Bd.p.fill("input[aria-label='الرقم السري للقفل المحلي']", PIN); await Bd.p.click("button:has-text('فتح')");
  await wait(Bd.p, "td:has-text('بانتظار المزامنة')"); ok("device B also saved an 8-unit offline sale of the same 10-unit stock", true);

  // ---- back online: A syncs and asks to post first, then B
  await A.ctx.setOffline(false);  await A.p.waitForSelector("td:has-text('مُزامَنة')", { timeout: 30000 });
  ok("device A auto-syncs on reconnect: a DRAFT now exists on the server", true);
  await A.p.click("button:has-text('طلب الترحيل')"); await A.p.waitForSelector("td:has-text('رُحِّلت على الخادم')", { timeout: 30000 });
  const docNo = (await A.p.textContent("tbody")).match(/INV-\d{4}-\d{6}/)?.[0]; ok("A: the server posted it and issued the final number " + docNo, !!docNo);
  await Bd.ctx.setOffline(false); await Bd.p.waitForSelector("td:has-text('مُزامَنة')", { timeout: 30000 });
  await Bd.p.click("button:has-text('طلب الترحيل')"); await Bd.p.waitForSelector("td:has-text('تعارض')", { timeout: 30000 });
  const conflictText = await Bd.p.textContent("tbody");
  ok("B: the second sale is a CONFLICT (stock no longer sufficient) with a clear Arabic explanation", conflictText.includes("المخزون لم يعد كافياً"));
  ok("B: the draft stays available (not lost, not posted)", conflictText.includes("إعادة المحاولة") && !conflictText.includes("رُحِّلت"));
  const stock = (await call(A.p, "GET", "/api/stock")).filter((s) => s.productId === prod).reduce((a, s) => a + Number(s.qty), 0);
  ok("server stock is exactly 2 (10 - 8), never negative", stock === 2);
  const tb = await call(A.p, "GET", "/api/reports/trial-balance"); ok("ledger balanced after the offline race", tb.balanced === true);
  const rec = await call(A.p, "GET", "/api/reports/inventory-reconciliation"); ok("inventory reconciles with the ledger", rec.ok === true);

  // ---- lock / wrong PIN
  await A.p.goto(B + "/sync"); await wait(A.p, "text=القفل المحلي مغلق"); await A.p.fill("input[aria-label='الرقم السري للقفل المحلي']", PIN); await A.p.click("button:has-text('فتح')"); await wait(A.p, "button:has-text('قفل الآن')"); await A.p.click("button:has-text('قفل الآن')"); await wait(A.p, "#pu");
  await A.p.fill("#pu", "000000"); await A.p.click(".card:has(#pu) button.primary"); await A.p.waitForSelector("text=الرقم السري غير صحيح"); ok("wrong PIN is refused", true);
  await A.p.fill("#pu", PIN); await A.p.click(".card:has(#pu) button.primary"); await A.p.waitForSelector("text=فُتح القفل"); ok("correct PIN unlocks", true);

  // ---- A4 PDF (server-side Chromium) and print page
  const inv = (await call(A.p, "GET", "/api/sales-invoices")).find((x) => x.docNo);
  await A.p.goto(B + "/print/sales-invoice/" + inv.id); await wait(A.p, ".sheet[data-ready='1']"); const txt = await A.p.textContent(".sheet");
  ok("print sheet: company header, number, customer and amount in words", txt.includes("شركة التجربة") && txt.includes(inv.docNo) && txt.includes("عميل سري الاسم") && txt.includes("فقط"));
  await A.p.screenshot({ path: "invoice-print.png", fullPage: true });
  const pdfRes = await A.p.request.get(B + "/api/pdf?path=" + encodeURIComponent("/print/sales-invoice/" + inv.id));
  const pdf = await pdfRes.body(); fs.writeFileSync("invoice.pdf", pdf);
  ok("PDF endpoint returns an A4 PDF", pdfRes.status() === 200 && pdf.subarray(0, 5).toString() === "%PDF-" && pdf.length > 8000);
  const info = execSync("pdfinfo invoice.pdf").toString(); ok("PDF is one page of A4 (595x842)", /Pages:\s+1/.test(info) && /59[45]\.\d+ x 84[12]/.test(info));
  const ptxt = execSync("pdftotext -layout invoice.pdf -").toString(); ok("PDF text contains the invoice number (and no HTML chrome)", ptxt.includes(inv.docNo) && !ptxt.includes("طباعة"));
  ok("PDF endpoint refuses non-print paths (no SSRF)", (await A.p.request.get(B + "/api/pdf?path=" + encodeURIComponent("http://169.254.169.254/"))).status() === 400 && (await A.p.request.get(B + "/api/pdf?path=" + encodeURIComponent("/api/users"))).status() === 400);
  const xl = await A.p.request.get(B + "/api/export/trial-balance"); ok("Excel export downloads", xl.status() === 200 && (await xl.body()).subarray(0, 2).toString() === "PK");

  // ---- dashboard
  await A.p.goto(B + "/"); await wait(A.p, "h2:has-text('المركز المالي الآن')"); await A.p.waitForSelector("text=سلامة الدفاتر"); const dash = await A.p.textContent(".main");
  ok("dashboard shows real numbers and the balance-equation check", dash.includes("24,000") && dash.includes("صفر فرق"));
  await A.p.screenshot({ path: "dashboard.png", fullPage: true });
  // mobile
  const m = await b.newContext({ viewport: { width: 390, height: 800 } }); const mp = await m.newPage(); await mp.goto(B + "/login"); await mp.fill("#u", "owner"); await mp.fill("#p", "Owner-Smoke-Pass-77"); await mp.click("button.primary"); await mp.waitForURL(B + "/");
  for (const path of ["/", "/sync", "/sales/new"]) { await mp.goto(B + path); await mp.waitForSelector("h1"); await mp.waitForTimeout(1200); ok(`mobile ${path}: no horizontal scroll`, await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); }
  await mp.goto(B + "/"); await mp.waitForTimeout(1500); await mp.screenshot({ path: "dashboard-mobile.png" });
  ok("no console/page errors", errs.length === 0); if (errs.length) out.push("  " + errs.slice(0, 4).join(" | "));
  console.log(out.join("\n")); await b.close();
})().catch((e) => { console.error("SMOKE ERROR", e.message.split("\n").slice(0, 8).join("\n")); process.exit(1); });
