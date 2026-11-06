// Server-side A4 PDF: headless Chromium renders our own /print pages (real Arabic shaping, RTL, fonts) with the caller's session.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "./errors";

let chain: Promise<unknown> = Promise.resolve();                         // one render at a time: Chromium is heavy on a small VPS
export const PRINT_PATH = /^\/print\/[a-z0-9\-/]{1,120}(\?[A-Za-z0-9=&_\-.]{0,200})?$/;     // strictly our own print pages (no SSRF)

const BASE_ARGS = ["--no-sandbox", "--disable-gpu", "--font-render-hinting=none"];
/** System Chromium when present (Docker/VPS); otherwise the self-contained build from @sparticuz/chromium (works on plain Node hosts such as Render, no apt/Docker needed). */
async function engine(): Promise<{ executablePath: string; args: string[] }> {
  if (process.env.PDF_ENGINE !== "bundled")
    for (const p of [process.env.CHROMIUM_PATH, "/usr/bin/chromium-browser", "/usr/bin/chromium", "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"]) if (p && existsSync(p)) return { executablePath: p, args: BASE_ARGS };
  try {
    const { default: Bundled } = await import("@sparticuz/chromium");
    const executablePath = await Bundled.executablePath();
    // Arabic-capable font for the footer template (it cannot use the page's web fonts): drop it where the bundled fontconfig looks.
    const dest = process.env.FONTCONFIG_PATH ?? join(tmpdir(), "fonts"); mkdirSync(dest, { recursive: true });
    const src = join(process.cwd(), "assets", "fonts");
    if (existsSync(src)) for (const f of readdirSync(src)) if (/\.ttf$/i.test(f) && !existsSync(join(dest, f))) copyFileSync(join(src, f), join(dest, f));
    return { executablePath, args: [...Bundled.args.filter((a) => !BASE_ARGS.includes(a)), ...BASE_ARGS] };
  } catch (e) {
    console.error(JSON.stringify({ level: "error", at: new Date().toISOString(), name: "PdfEngineMissing", message: String((e as Error)?.message ?? e).slice(0, 300) }));
    throw new AppError(503, "PDF_UNAVAILABLE", "محرك PDF غير متوفر على الخادم");
  }
}

export function renderPdf(origin: string, path: string, sessionCookie: string): Promise<Buffer> {
  if (!PRINT_PATH.test(path)) throw new AppError(400, "BAD_PATH", "مسار طباعة غير صالح");
  const run = async () => {
    const { chromium } = await import("playwright-core");
    const eng = await engine();
    const browser = await chromium.launch({ executablePath: eng.executablePath, args: eng.args });
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
