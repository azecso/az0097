/* Service worker — app shell only.
 * - /api/* is NEVER cached (financial data stays fresh and off disk); offline data lives in the app's encrypted vault.
 * - /_next/static, fonts, icons: cache-first (content-hashed).
 * - Page navigations: network-first (3 s), fall back to the last good copy, then /offline.
 * - Updates: a new worker waits; the app shows "update available" and sends SKIP_WAITING when the user is ready (never mid-edit). */
const VERSION = "v1";
const SHELL = `erp-shell-${VERSION}`, STATIC = `erp-static-${VERSION}`;
const PRECACHE = ["/offline", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];
const WARM_ROUTES = ["/", "/login", "/sync", "/sales", "/sales/new", "/sales/quotes", "/sales/quotes/new", "/sales/receipts", "/expenses", "/offline"];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => undefined)); });
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => { for (const k of await caches.keys()) if (![SHELL, STATIC].includes(k)) await caches.delete(k); await self.clients.claim(); })());
});
self.addEventListener("message", (e) => {
  if (e.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (e.data?.type === "WARM") e.waitUntil(warm());
  if (e.data?.type === "PURGE") e.waitUntil(caches.delete(SHELL));
});

/** Fetches the offline-capable routes (and the hashed assets they reference) so they open without a network. */
async function warm() {
  const shell = await caches.open(SHELL), stat = await caches.open(STATIC);
  for (const url of WARM_ROUTES) {
    try {
      const res = await fetch(url, { credentials: "same-origin" }); if (!res.ok) continue;
      const html = await res.clone().text(); await shell.put(url, res);
      const assets = new Set([...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1]));
      for (const a of assets) if (!(await stat.match(a))) { try { const r = await fetch(a); if (r.ok) await stat.put(a, r); } catch { /* ignore */ } }
    } catch { /* offline during warm: ignore */ }
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/print/")) return;           // network only, never cached
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/") || /\.(woff2?|png|svg|webp)$/.test(url.pathname)) {
    e.respondWith((async () => { const c = await caches.open(STATIC); const hit = await c.match(req); if (hit) return hit; const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res; })());
    return;
  }
  if (req.mode === "navigate") {
    e.respondWith((async () => {
      const shell = await caches.open(SHELL);
      try {
        const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 3000))]);
        if (res.ok) shell.put(url.pathname, res.clone());
        return res;
      } catch {
        return (await shell.match(url.pathname)) || (await shell.match(req)) || (await shell.match("/offline")) || new Response("غير متصل", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
    })());
  }
});
