"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { api, ApiError, setCsrf } from "@/lib/client";
import { can, MeCtx, type Me } from "@/components/me";
import { useOffline } from "@/lib/offline/use";
import { unlockVault, vaultStatus, wipeVault } from "@/lib/offline/vault";


const NAV = [
  { href: "/", label: "لوحة التحكم" },
  { href: "/sales", label: "المبيعات", perm: "sales:view" }, { href: "/purchases", label: "المشتريات", perm: "purchase:view" }, { href: "/cash", label: "النقدية والعهدة", perm: "voucher:view" }, { href: "/contacts", label: "العملاء والموردون", perm: "contacts:view" },
  { href: "/inventory/products", label: "المواد", perm: "products:view" }, { href: "/inventory/stock", label: "المخزون", perm: "products:view" },
  { href: "/inventory/transfers", label: "تحويل المخزون", perm: "stock_transfer:view" }, { href: "/inventory/counts", label: "الجرد", perm: "inventory_count:view" },
  { href: "/expenses", label: "المصاريف", perm: "expense:view" }, { href: "/payroll", label: "الرواتب", perm: "payroll:view" }, { href: "/reports", label: "التقارير", perm: "report:view" }, { href: "/capital/returns", label: "إرجاع رأس المال", perm: "capital:view" }, { href: "/capital", label: "رأس المال والسحوبات", perm: "capital:view" },
  { href: "/profits", label: "الأرباح والتوزيع", perm: "profit_settlement:view" }, { href: "/partners", label: "الشراكة والتسويات", perm: "profit_settlement:view" },
  { href: "/accounting", label: "المحاسبة", perm: "journal:view" }, { href: "/accounting/opening", label: "الأرصدة الافتتاحية", perm: "opening_balance:view" }, { href: "/accounting/periods", label: "إقفال الفترات", perm: "period_close:view" },
  { href: "/sync", label: "المزامنة والعمل أوفلاين" }, { href: "/settings/company", label: "الشركة" }, { href: "/settings/fx", label: "أسعار الصرف", perm: "fx_rate:view" },
  { href: "/settings/users", label: "المستخدمون والصلاحيات", owner: true }, { href: "/settings/security", label: "الأمان (2FA)", owner: true }, { href: "/settings/reset", label: "تصفير البيانات", owner: true }, { href: "/settings/backup", label: "سلامة البيانات والنسخ", owner: true }, { href: "/settings/audit", label: "سجل التدقيق", perm: "audit:view" },
];

export default function Shell({ children }: { children: React.ReactNode }) {
  // Give every table cell its column title so the phone layout (one card per row) can show "what is this number".
  useEffect(() => {
    let raf = 0;
    const label = () => document.querySelectorAll(".cards-as-list table").forEach((t) => {
      const heads = Array.from(t.querySelectorAll("thead th")).map((h) => h.textContent?.trim() ?? "");
      t.querySelectorAll("tbody tr, tfoot tr").forEach((tr) => Array.from(tr.children).forEach((c, i) => { if (c.tagName === "TD" && heads[i] && !c.hasAttribute("colspan") && c.getAttribute("data-label") !== heads[i]) c.setAttribute("data-label", heads[i]!); }));
    });
    const mo = new MutationObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(label); });
    mo.observe(document.body, { childList: true, subtree: true }); label();
    return () => { mo.disconnect(); cancelAnimationFrame(raf); };
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [bootError, setBootError] = useState(""); const [slow, setSlow] = useState(false); const [health, setHealth] = useState("");
  const [me, setMe] = useState<Me | null>(null); const path = usePathname(); const router = useRouter(); const off = useOffline(); const [fromCache, setFromCache] = useState(false); const [pin, setPin] = useState(""); const [pinErr, setPinErr] = useState(""); const [update, setUpdate] = useState<ServiceWorkerRegistration | null>(null);
  // The identity/permission list is not secret (the server re-checks every request). It is cached so the shell can open offline.
  const loadMe = useCallback(async () => {
    setBootError("");
    try {
      const r = await api<Me & { csrf: string }>("/api/auth/me"); setCsrf(r.csrf); setMe(r); setFromCache(false);
      try { localStorage.setItem("erp-me", JSON.stringify({ companyId: r.companyId, user: r.user, permissions: r.permissions })); } catch { /* storage disabled */ }
      const v = await vaultStatus().catch(() => null);                                    // another user on this device: never keep their offline data
      if (v?.initialized && v.userId && v.userId !== r.user.username) await wipeVault().catch(() => {});
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { localStorage.removeItem("erp-me"); window.location.href = "/login"; return; }
      try { const c = JSON.parse(localStorage.getItem("erp-me") ?? "null"); if (c) { setMe(c); setFromCache(true); return; } } catch { /* ignore */ }
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) { setBootError(e.message); return; }      // server/database unreachable: say so instead of an endless spinner
      window.location.href = "/login";
    }
  }, []);
  useEffect(() => { void loadMe(); }, [loadMe]);
  useEffect(() => { if (off.online && fromCache) void loadMe(); }, [off.online, fromCache, loadMe]);       // back online: re-validate the session and get a fresh CSRF token
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").then((reg) => {
        const watch = () => { if (reg.waiting && navigator.serviceWorker.controller) setUpdate(reg); };
        watch(); reg.addEventListener("updatefound", () => reg.installing?.addEventListener("statechange", watch));
        navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: "WARM" }));
      }).catch(() => {});
      const hadController = !!navigator.serviceWorker.controller; let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !reloaded) { reloaded = true; window.location.reload(); } });   // only for UPDATES, never for the first install
    }
  }, []);
  useEffect(() => { setMenuOpen(false); }, [path]);                 // leaving a page closes the phone menu
  useEffect(() => {          // still loading after 6 s: probe the server so the user sees WHY (sleeping host, database down...)
    if (me) { setSlow(false); return; }
    const t = setTimeout(async () => { setSlow(true); try { const r = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(8000) }); const j = await r.json().catch(() => null); setHealth(r.ok && j?.ok ? "الخادم يعمل وقاعدة البيانات متصلة" : "الخادم يعمل لكن قاعدة البيانات غير متاحة"); } catch { setHealth("الخادم لا يستجيب (قد يكون في وضع الإسبات أو يُعاد تشغيله)"); } }, 6000);
    return () => clearTimeout(t);
  }, [me, bootError]);
  if (!me) return <main className="login"><div className="card" style={{ textAlign: "center" }}><p>{bootError ? `تعذّر الاتصال: ${bootError}` : "جارٍ التحميل…"}</p>
    {(slow || bootError) && <><p style={{ color: "var(--muted)" }}>{health || "جارٍ فحص الخادم…"}</p><p style={{ fontSize: 13, color: "var(--muted)" }}>الاستضافات المجانية تنام عند عدم الاستخدام وتحتاج حتى دقيقة للاستيقاظ. إن استمرت المشكلة راجع سجلات الخدمة.</p>
      <button className="primary" onClick={() => { setSlow(false); setHealth(""); void loadMe(); }}>إعادة المحاولة</button></>}</div></main>;
  const items = NAV.filter((n) => (!n.owner || me.user.isOwner) && (!n.perm || can(me, n.perm)));
  const nav = items.map((n) => <Link key={n.href} href={n.href} aria-current={path === n.href || (n.href !== "/" && path.startsWith(n.href + "/")) ? "page" : undefined}>{n.label}</Link>);
  return (
    <MeCtx.Provider value={me}>
      <div className="shell">
        <nav className="side" aria-label="القائمة الرئيسية"><strong style={{ padding: "8px 12px" }}>النظام المحاسبي</strong>{nav}</nav>
        <div className="main">
          <div className="status">
            {path !== "/" && <button type="button" aria-label="رجوع خطوة" onClick={() => (window.history.length > 1 ? router.back() : router.push("/"))}>← رجوع</button>}
            <Link href="/sync" aria-label="حالة الاتصال والمزامنة" style={{ display: "inline-flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span><span className={off.online ? "dot" : "dot off"} />{off.online ? "متصل" : "غير متصل (وضع أوفلاين)"}</span>
              {off.pending > 0 && <span className="badge">⏳ {off.pending} بانتظار المزامنة</span>}{off.problems > 0 && <span className="badge" style={{ color: "var(--danger)" }}>⚠ {off.problems} تعارض/رفض</span>}
              {off.syncing && <span className="badge">جارٍ المزامنة…</span>}{off.vault.initialized && <span title={off.vault.unlocked ? "القفل المحلي مفتوح" : "القفل المحلي مغلق"}>{off.vault.unlocked ? "🔓" : "🔒"}</span>}</Link>
            <span>{me.user.displayName}{me.user.isOwner ? " (المالك)" : ""}</span>
            <button onClick={async () => { await api("/api/auth/logout", { method: "POST" }).catch(() => {}); await wipeVault().catch(() => {}); localStorage.removeItem("erp-me"); navigator.serviceWorker?.controller?.postMessage({ type: "PURGE" }); window.location.href = "/login"; }}>خروج</button>
          </div>
          {off.vault.initialized && !off.vault.unlocked && <div className="msg" role="status" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>🔒 القفل المحلي مغلق — افتحه لاستخدام المسودات والبيانات أوفلاين:
            <input aria-label="الرقم السري للقفل المحلي" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} dir="ltr" style={{ maxWidth: 160 }} autoComplete="off" />
            <button className="primary" onClick={() => unlockVault(pin).then(() => { setPin(""); setPinErr(""); }).catch((e) => setPinErr((e as Error).message))}>فتح</button>{pinErr && <span style={{ color: "var(--danger)" }}>{pinErr}</span>}</div>}
          {update && <div className="msg" role="status">تحديث جديد للتطبيق متوفر. <button onClick={() => update.waiting?.postMessage({ type: "SKIP_WAITING" })}>حدّث الآن</button> <small>(احفظ عملك أولاً)</small></div>}
          {off.stale && <div className="msg err" role="alert">⚠ توجد مسودات على هذا الجهاز لم تُزامَن منذ أكثر من 24 ساعة — اتصل بالإنترنت وزامنها، أو صدّرها من صفحة المزامنة.</div>}
          {!off.online && <div className="msg" role="status">📴 وضع أوفلاين: تُحفظ المسودات على جهازك مشفّرة، ولا يصدر رقم نهائي ولا يُرحَّل شيء ولا يُخصم مخزون إلا بعد تحقق الخادم.</div>}
          {children}
        </div>
        <nav className="tabbar" aria-label="تنقل سريع">{items.slice(0, 4).map((n) => <Link key={n.href} href={n.href}>{n.label}</Link>)}
          <button type="button" className="tabmore" aria-expanded={menuOpen} aria-controls="phone-menu" onClick={() => setMenuOpen((v) => !v)}>{menuOpen ? "✕ إغلاق" : "☰ القائمة"}</button></nav>
        {menuOpen && <div className="drawer" id="phone-menu" role="dialog" aria-label="كل الأقسام"><strong style={{ display: "block", padding: "8px 4px 12px", fontSize: 18 }}>كل الأقسام</strong>{nav}</div>}
      </div>
    </MeCtx.Provider>
  );
}
