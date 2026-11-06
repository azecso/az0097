// Profit statement + withdrawal: expenses come out of profit (never capital), split between owner/partner, owner pays profit to a person, voucher prints.
const { chromium } = require("./pw.cjs"); const { execFileSync } = require("node:child_process"); const fs = require("node:fs");
const BASE = process.env.E2E_BASE || "http://localhost:3100";
(async () => {
  const b = await chromium.launch(); const out = []; const ok = (n, c) => out.push((c ? "PASS " : "FAIL ") + n);
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } }); const p = await ctx.newPage(); const errs = [];
  p.on("pageerror", (e) => errs.push(e.message)); p.on("console", (m) => { if (m.type() === "error" && !/status of 40[139]/.test(m.text())) errs.push(m.text()); });
  const B = BASE; const wait = (t) => p.waitForSelector(t, { timeout: 15000 });
  await p.goto(B + "/login"); await p.fill("#u", "owner"); await p.fill("#p", "Owner-Smoke-Pass-77"); await p.click("button.primary"); await p.waitForURL(B + "/");
  const csrf = (await (await ctx.request.get(B + "/api/auth/me")).json()).csrf; const H = { origin: B, "x-csrf-token": csrf };
  const post = async (path, data, method = "POST") => { const r = await ctx.request.fetch(B + path, { method, headers: H, data }); const j = await r.json().catch(() => null); if (!r.ok()) throw new Error(`${method} ${path} -> ${r.status()} ${JSON.stringify(j)}`); return j; };
  const cash = (await (await ctx.request.get(B + "/api/cash-accounts")).json()).find((c) => c.currency === "IQD" && c.kind === "MAIN_CASH");
  const cap = await post("/api/capital", { kind: "INJECTION", docDate: "2026-11-01", cashAccountId: cash.id, currency: "IQD", amount: "10000000", reason: "رأس مال ابتدائي" }); await post(`/api/capital/${cap.id}/approve`, { totp: null });
  const cust = await post("/api/contacts", { kind: "CUSTOMER", code: "C-PF", name: "عميل الأرباح", phones: [], paymentTermsDays: 0 }); const sup = await post("/api/contacts", { kind: "SUPPLIER", code: "S-PF", name: "مورد", phones: [], paymentTermsDays: 0 });
  const prod = await post("/api/products", { code: "PF-1", name: "قطعة", baseUom: "قطعة", qtyDecimals: 0, uoms: [] });
  const buy = await post("/api/purchases", { supplierId: sup.id, docDate: "2026-11-01", paymentType: "CREDIT", currency: "IQD", lines: [{ productId: prod.id, uom: "قطعة", qty: "200", unitPrice: "7000" }], charges: [] }); await post(`/api/purchases/${buy.id}/post`, {});
  const inv = await post("/api/sales-invoices", { customerId: cust.id, docDate: "2026-11-02", saleType: "CREDIT", currency: "IQD", deliveryMode: "WITH_INVOICE", discount: "0", lines: [{ productId: prod.id, uom: "قطعة", qty: "100", unitPrice: "10000", lineDiscount: "0" }] }); await post(`/api/sales-invoices/${inv.id}/post`, {});
  const rc = await post("/api/customer-receipts", { customerId: cust.id, docDate: "2026-11-03", cashAccountId: cash.id, currency: "IQD", amount: "1000000", allocations: [{ invoiceId: inv.id, amount: "1000000" }] }); await post(`/api/customer-receipts/${rc.id}/post`, {});
  const cats = await (await ctx.request.get(B + "/api/expense-categories")).json();
  const ex = await post("/api/expenses", { docDate: "2026-11-04", categoryId: cats[0].id, description: "إيجار", currency: "IQD", amount: "100000", paymentMode: "ACCRUED" }); await post(`/api/expenses/${ex.id}/post`, {});

  await p.goto(B + "/profits"); await wait("h2:has-text('بيان الربح')"); await p.waitForFunction(() => document.body.textContent.includes("200,000"));
  const t = await p.textContent("body");
  ok("statement: invoiced profit 300,000, expense 100,000 deducted from PROFIT, net 200,000", t.includes("300,000") && t.includes("100,000") && t.includes("200,000"));
  ok("capital stays 10,000,000 and is shown separately", t.includes("10,000,000") && t.includes("لا تمسّه المصاريف"));
  ok("each person gets 100,000 of the net profit", (await p.$$eval(".card", (cs) => cs.filter((c) => c.textContent.includes("المتاح له للسحب") && c.textContent.includes("100,000")).length)) >= 2);
  const pcard = p.locator(".card", { hasText: "الشريك" }).filter({ hasText: "المتاح له للسحب" }).last();
  await pcard.locator("button:has-text('صرف / سحب أرباح')").click(); await wait("#am"); await p.fill("#am", "60000"); await p.click("button:has-text('تأكيد الصرف')"); await wait(".msg.ok");
  await p.waitForSelector("td:has-text('PY-')"); const t2 = await p.textContent("body");
  ok("withdrawal recorded in the log with a voucher number and the partner's available share drops to 40,000", t2.includes("60,000") && t2.includes("40,000") && /PY-\d{4}-\d{6}/.test(t2));
  ok("over-withdrawal is refused with a clear message", await (async () => { await pcard.locator("button:has-text('صرف / سحب أرباح')").click(); await wait("#am"); await p.fill("#am", "40001"); await p.click("button:has-text('تأكيد الصرف')"); await wait(".msg.err"); return (await p.textContent(".msg.err")).includes("يتجاوز"); })());
  const payouts = await (await ctx.request.get(B + "/api/profits")).json(); const pid = payouts.payouts[0].id;
  const pdf = await (await ctx.request.get(B + `/api/pdf?path=${encodeURIComponent("/print/doc/profit-payout/" + pid)}`)).body(); fs.mkdirSync("inv", { recursive: true }); fs.writeFileSync("inv/profit-payout.pdf", pdf);
  const txt = execFileSync("pdftotext", ["inv/profit-payout.pdf", "-"], { encoding: "utf8" });
  ok("profit payout voucher prints (official sheet, amount 60,000, voucher number)", pdf.slice(0, 5).toString() === "%PDF-" && txt.includes("60,000") && /PY-\d{4}-\d{6}/.test(txt) && /owner/.test(txt));
  const tb = await (await ctx.request.get(B + "/api/reports/trial-balance")).json(); const c3100 = tb.rows.find((r) => r.code === "3100");
  ok("ledger balanced and capital account unchanged by expenses and withdrawals", tb.balanced === true && Number(c3100.credit) - Number(c3100.debit) === 10000000);
  // invoice 9,000 (cost 7,000): 8,000 collected in cash, 1,000 of the profit was already distributed outside the system
  const inv2 = await post("/api/sales-invoices", { customerId: cust.id, docDate: "2026-11-05", saleType: "CREDIT", currency: "IQD", deliveryMode: "WITH_INVOICE", discount: "0", lines: [{ productId: prod.id, uom: "قطعة", qty: "1", unitPrice: "9000", lineDiscount: "0" }] }); await post(`/api/sales-invoices/${inv2.id}/post`, {});
  await p.goto(B + "/sales/receipts"); await wait("#c"); await p.selectOption("#c", { label: "عميل الأرباح" });
  await p.waitForSelector("td:has-text('بدون أرباح')"); ok("nothing is allocated automatically: the invoice list waits for the user's choice", (await p.inputValue("input[aria-label^='المبلغ المقبوض على']")) === "");
  await p.fill("input[aria-label^='المبلغ المقبوض على']", "8000"); await p.waitForFunction(() => document.querySelector("#a").value === "8000"); await p.click("label:has-text('بدون أرباح') input"); await p.fill("input[aria-label='مبلغ الربح الموزَّع خارج النظام']", "1000"); await p.fill("input[aria-label='ملاحظة']", "ربح سُلّم للشريكين مباشرة");
  ok("the box shows what is settled and what remains (0 after 8,000 cash + 1,000 outside)", (await p.textContent("small:has-text('الباقي بعد السند')")).includes("0"));
  await p.click("button.primary:has-text('حفظ كمسودة')"); await wait(".msg.ok"); await p.click("td button.primary:has-text('ترحيل')"); await p.waitForFunction(() => document.querySelector(".msg.ok")?.textContent.includes("تم الترحيل"));
  const g2 = await (await ctx.request.get(B + `/api/sales-invoices/${inv2.id}`)).json();
  ok("invoice closed: 8,000 cash + 1,000 distributed outside, nothing outstanding", Number(g2.collected) === 8000 && Number(g2.external) === 1000 && Number(g2.outstanding) === 0);
  const er = await (await ctx.request.get(B + "/api/reports/external-profits")).json(); ok("report lists it with collected and external amounts", er.rows.length === 1 && Number(er.rows[0].cash) === 8000 && Number(er.rows[0].external) === 1000);
  const rcs = await (await ctx.request.get(B + "/api/customer-receipts")).json(); const rc2 = rcs.find((r) => r.status === "POSTED" && Number(r.amount) === 8000);
  const rpdf = await (await ctx.request.get(B + `/api/pdf?path=${encodeURIComponent("/print/receipt/" + rc2.id)}`)).body(); fs.writeFileSync("inv/receipt-external.pdf", rpdf);
  const rtxt = execFileSync("pdftotext", ["inv/receipt-external.pdf", "-"], { encoding: "utf8" });
  ok("the printed receipt shows the FULL amount 9,000 like the invoice (not only the 8,000 cash)", rtxt.includes("9,000") && !rtxt.includes("1,000"));
  await p.goto(B + "/profits"); await wait("h2:has-text('بيان الربح')"); await p.waitForFunction(() => document.body.textContent.includes("وُزّعت خارج النظام"));
  ok("profit statement mentions the externally distributed profit without distributing it again", (await p.textContent("body")).includes("1,000"));
  // collecting from the invoice page itself, with the same "no profit" option
  const inv4 = await post("/api/sales-invoices", { customerId: cust.id, docDate: "2026-11-05", saleType: "CREDIT", currency: "IQD", deliveryMode: "WITH_INVOICE", discount: "0", lines: [{ productId: prod.id, uom: "قطعة", qty: "1", unitPrice: "9000", lineDiscount: "0" }] }); await post(`/api/sales-invoices/${inv4.id}/post`, {});
  await p.goto(B + `/sales/${inv4.id}`); await wait("h2:has-text('تسجيل قبض على هذه الفاتورة')");
  await p.selectOption(".card:has(h2:has-text('تسجيل قبض')) select", { index: 1 }); await p.fill(".card:has(h2:has-text('تسجيل قبض')) input[inputmode=decimal] >> nth=0", "8000");
  await p.click("label:has-text('بدون أرباح') input"); await p.fill(".card:has(h2:has-text('تسجيل قبض')) .row >> nth=1 >> input >> nth=0", "1000"); await p.fill(".card:has(h2:has-text('تسجيل قبض')) .row >> nth=1 >> input >> nth=1", "ربح سُلّم للشركاء");
  await p.click("button.primary:has-text('قبض')"); await p.waitForFunction(() => document.body.textContent.includes("ربح موزَّع خارج النظام") && document.querySelector(".msg.ok"));
  const g4 = await (await ctx.request.get(B + `/api/sales-invoices/${inv4.id}`)).json();
  ok("collecting from the invoice page with «بدون أرباح»: 8,000 cash + 1,000 outside closes the invoice", Number(g4.collected) === 8000 && Number(g4.external) === 1000 && Number(g4.outstanding) === 0);
  // edit and delete a POSTED invoice from its page: same number, no reversal shown
  const inv3 = await post("/api/sales-invoices", { customerId: cust.id, docDate: "2026-11-05", saleType: "CREDIT", currency: "IQD", deliveryMode: "WITH_INVOICE", discount: "0", lines: [{ productId: prod.id, uom: "قطعة", qty: "1", unitPrice: "5000", lineDiscount: "0" }] }); const posted3 = await post(`/api/sales-invoices/${inv3.id}/post`, {});
  await p.goto(B + `/sales/${inv3.id}`); await wait("button:has-text('تعديل الفاتورة')");
  ok("posted invoice page offers edit and delete, and no reversal card", (await p.locator("button:has-text('حذف الفاتورة')").count()) === 1 && !(await p.textContent("body")).includes("عكس الفاتورة"));
  await p.click("button:has-text('تعديل الفاتورة')"); await p.waitForURL(/\/sales\/new\?edit=/); await p.waitForFunction(() => [...document.querySelectorAll(".row.card input")].some((i) => i.value === "5000"));
  for (const i of await p.locator(".row.card input").all()) if (await i.evaluate((n) => n.value === "1" && n.getAttribute("inputmode") === "decimal")) { await i.fill("3"); break; }
  await p.click("button.primary:has-text('حفظ كمسودة')"); await p.waitForURL((u) => /\/sales\/[0-9a-f-]{36}$/.test(u.pathname) && !u.pathname.endsWith(inv3.id)); await p.waitForFunction(() => document.body.textContent.includes("15,000"));
  ok("editing a posted invoice keeps its number and recomputes the total (3 x 5,000)", (await p.textContent("h1")).includes(posted3.docNo));
  const lst = await (await ctx.request.get(B + "/api/sales-invoices")).json(); ok("the list shows ONE record for that number (old version hidden)", lst.filter((x) => x.docNo === posted3.docNo).length === 1);
  p.once("dialog", (dlg) => void dlg.accept("إدخال خاطئ")); await p.click("button:has-text('حذف الفاتورة')"); await p.waitForURL(B + "/sales"); await p.waitForFunction((n) => !document.body.textContent.includes(n), posted3.docNo);
  ok("deleting a posted invoice removes it from the list", true);
  await p.setViewportSize({ width: 390, height: 800 }); await p.goto(B + "/profits"); await wait("h1"); ok("mobile /profits: no horizontal scroll", await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  ok("no console/page errors", errs.length === 0); if (errs.length) out.push("ERRORS: " + errs.slice(0, 4).join(" | "));
  console.log(out.join("\n")); await b.close();
})().catch((e) => { console.log("SMOKE ERROR " + e.message); process.exit(1); });
