// Server-side A4 PDF: headless Chromium renders our own /print pages (real Arabic shaping, RTL, fonts) with the caller's session.
import { existsSync } from "node:fs";
import { AppError } from "./errors";

let chain: Promise<unknown> = Promise.resolve();                         // one render at a time: Chromium is heavy on a small VPS
export const PRINT_PATH = /^\/print\/[a-z0-9\-/]{1,120}(\?[A-Za-z0-9=&_\-.]{0,200})?$/;     // strictly our own print pages (no SSRF)

function chromiumPath(): string {
  for (const p of [process.env.CHROMIUM_PATH, "/usr/bin/chromium-browser", "/usr/bin/chromium", "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"]) if (p && existsSync(p)) return p;
  throw new AppError(503, "PDF_UNAVAILABLE", "محرك PDF غير متوفر على الخادم (CHROMIUM_PATH)");
}

export function renderPdf(origin: string, path: string, sessionCookie: string): Promise<Buffer> {
  if (!PRINT_PATH.test(path)) throw new AppError(400, "BAD_PATH", "مسار طباعة غير صالح");
  const run = async () => {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: chromiumPath(), args: ["--no-sandbox", "--disable-gpu", "--font-render-hinting=none"] });
    try {
      const ctx = await browser.newContext({ locale: "ar", viewport: { width: 1000, height: 1400 } });
      await ctx.addCookies([{ name: "erp_session", value: sessionCookie, url: origin, httpOnly: true, sameSite: "Lax" }]);
      const page = await ctx.newPage();
      await page.goto(origin + path, { waitUntil: "load", timeout: 30_000 });
      await page.waitForSelector('[data-ready="1"]', { timeout: 20_000 });
      await page.emulateMedia({ media: "print" });
      // A page may ship its own repeating footer (company data + page numbers) as <template id="pdf-footer">: Chromium prints it in the bottom margin of EVERY page.
      const footer = await page.evaluate(() => document.querySelector("template#pdf-footer")?.innerHTML ?? null);
      return Buffer.from(await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true, displayHeaderFooter: !!footer, headerTemplate: "<span></span>", footerTemplate: footer ?? "<span></span>" }));
    } finally { await browser.close(); }
  };
  const guarded = async () => { try { return await run(); } catch (e) { if (e instanceof AppError) throw e; console.error(JSON.stringify({ level: "error", at: new Date().toISOString(), name: "PdfRenderError", message: String((e as Error)?.message ?? e).slice(0, 300) })); throw new AppError(503, "PDF_FAILED", "تعذّر تشغيل محرك PDF على الخادم (قد يكون غير مثبّت أو الذاكرة غير كافية)"); } };
  const p = chain.then(guarded, guarded); chain = p.catch(() => undefined); return p;
}
