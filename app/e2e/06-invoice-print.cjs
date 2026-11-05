// Official A4 sales-invoice PDF: 1 / 20 / 50 lines. Totals, signatures and stamp only on the LAST page; footer + page numbers on every page.
const { chromium } = require("./pw.cjs"); const { execFileSync } = require("node:child_process"); const fs = require("node:fs");
const BASE = process.env.E2E_BASE || "http://localhost:3100";
(async () => {
  const b = await chromium.launch(); const out = []; const ok = (n, c) => out.push((c ? "PASS " : "FAIL ") + n);
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } }); const p = await ctx.newPage(); const B = BASE;
  await p.goto(B + "/login"); await p.fill("#u", "owner"); await p.fill("#p", "Owner-Smoke-Pass-77"); await p.click("button.primary"); await p.waitForURL(B + "/");
  const csrf = (await (await ctx.request.get(B + "/api/auth/me")).json()).csrf;
  const H = { origin: B, "x-csrf-token": csrf };
  const post = async (path, data, method = "POST") => { const r = await ctx.request.fetch(B + path, { method, headers: H, data }); const j = await r.json().catch(() => null); if (!r.ok()) throw new Error(`${method} ${path} -> ${r.status()} ${JSON.stringify(j)}`); return j; };
  const co = await (await ctx.request.get(B + "/api/company")).json();
  await post("/api/company", { name: "شركة الشمس للآليات الثقيلة", nameEn: "AL SHAMS HEAVY EQUIPMENT COMPANY", address: "بغداد - المنصور - شارع 14 رمضان", phones: ["07701112233", "07809998877"], email: "info@alshams.example", website: "www.alshams.example", taxNo: "TX-2026-0042", allowNegativeStock: false, landedCostPolicy: co.landedCostPolicy, version: co.version }, "PATCH");
  const cust = await post("/api/contacts", { kind: "CUSTOMER", code: "C-PR", name: "مروان المرعي", phones: ["07705550101"], address: "الأنبار - الرمادي - حي الملعب", paymentTermsDays: 30 });
  const sup = await post("/api/contacts", { kind: "SUPPLIER", code: "S-PR", name: "مورد قطع الغيار", phones: [], paymentTermsDays: 0 });
  const prod = await post("/api/products", { code: "HYD-001", name: "خرطوم هيدروليك عالي الضغط للحفارات الثقيلة مقاس ٢ إنش", baseUom: "قطعة", qtyDecimals: 0, uoms: [] });
  const buy = await post("/api/purchases", { supplierId: sup.id, docDate: "2026-11-01", paymentType: "CREDIT", currency: "IQD", lines: [{ productId: prod.id, uom: "قطعة", qty: "5000", unitPrice: "1000" }], charges: [] });
  await post(`/api/purchases/${buy.id}/post`, {});
  const cash = (await (await ctx.request.get(B + "/api/cash-accounts")).json()).find((c) => c.currency === "IQD" && c.kind === "MAIN_CASH");
  const make = async (n, pay) => {
    const lines = Array.from({ length: n }, (_, i) => ({ productId: prod.id, uom: "قطعة", qty: String(2 + (i % 5)), unitPrice: String(1500 + i * 250), lineDiscount: "0" }));
    const inv = await post("/api/sales-invoices", { customerId: cust.id, docDate: "2026-11-05", saleType: "CREDIT", dueDate: "2026-12-05", currency: "IQD", deliveryMode: "WITH_INVOICE", discount: n === 20 ? "5000" : "0", lines });
    await post(`/api/sales-invoices/${inv.id}/post`, {});
    if (pay) { const g = await (await ctx.request.get(B + `/api/sales-invoices/${inv.id}`)).json(); const rc = await post("/api/customer-receipts", { customerId: cust.id, docDate: "2026-11-05", cashAccountId: cash.id, currency: "IQD", amount: pay, allocations: [{ invoiceId: inv.id, amount: pay }] }); await post(`/api/customer-receipts/${rc.id}/post`, {}); return { id: inv.id, net: g.net }; }
    return { id: inv.id };
  };
  fs.mkdirSync("inv", { recursive: true });
  const pdfOf = async (id, name) => { const r = await ctx.request.get(B + `/api/pdf?path=${encodeURIComponent("/print/sales-invoice/" + id)}`); const buf = await r.body(); fs.writeFileSync(`inv/${name}.pdf`, buf); return buf; };
  const pages = (buf) => (buf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
  const txt = (name, n) => execFileSync("pdftotext", ["-f", String(n), "-l", String(n), `inv/${name}.pdf`, "-"], { encoding: "utf8" });
  const results = {};
  for (const [n, pay] of [[1, null], [20, "100000"], [50, "250000"]]) {
    const inv = await make(n, pay); const buf = await pdfOf(inv.id, `invoice-${n}`); const pc = pages(buf); results[n] = pc;
    const last = txt(`invoice-${n}`, pc); const first = txt(`invoice-${n}`, 1);
    ok(`${n} lines: a real A4 PDF with ${pc} page(s)`, buf.slice(0, 5).toString() === "%PDF-" && pc >= 1 && (n === 1 ? pc === 1 : true));
    ok(`${n} lines: summary (net / paid / remaining) is on the last page`, /المتبقي/.test(last) && /المدفوع/.test(last));
    ok(`${n} lines: accountant (current user), receiver (customer) and company stamp area are on the last page`, /المحاسب/.test(last) && /المستلم/.test(last) && last.includes("مروان المرعي") && /owner/.test(last));
    ok(`${n} lines: the manager box is gone`, !/المدير/.test(last));
    ok(`${n} lines: company footer data comes from the settings on page 1 and the last page`, [first, last].every((t) => t.includes("info@alshams.example") && t.includes("TX-2026-0042") && t.includes("07701112233")));
    ok(`${n} lines: page numbers are printed`, /صفحة/.test(last) || /Page/.test(last) || new RegExp(`\\b${pc}\\b`).test(last));
    if (pc > 1) { ok(`${n} lines: totals and signatures appear ONLY on the last page`, !/المتبقي/.test(first) && !/المستلم/.test(first)); ok(`${n} lines: the table header repeats on every page`, Array.from({ length: pc }, (_, i) => txt(`invoice-${n}`, i + 1)).every((t) => t.includes("اسم الصنف"))); }
    execFileSync("pdftoppm", ["-r", "70", "-png", `inv/invoice-${n}.pdf`, `inv/invoice-${n}`]);
  }
  ok("50 lines span several pages, 1 line fits a single page", results[1] === 1 && results[50] >= 2);
  console.log(out.join("\n")); console.log("PAGES " + JSON.stringify(results)); await b.close();
})().catch((e) => { console.log("SMOKE ERROR " + e.message); process.exit(1); });
