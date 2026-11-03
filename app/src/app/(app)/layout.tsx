"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api, ApiError, setCsrf } from "@/lib/client";
import { can, MeCtx, type Me } from "@/components/me";
import { useOffline } from "@/lib/offline/use";
import { unlockVault, vaultStatus, wipeVault } from "@/lib/offline/vault";


const NAV = [
  { href: "/", label: "لوحة التحكم" },
  { href: "/sales", label: "المبيعات", perm: "sales:view" }, { href: "/purchases", label: "المشتريات", perm: "purchase:view" }, { href: "/cash", label: "النقدية والعهدة", perm: "voucher:view" }, { href: "/contacts", label: "العملاء والموردون", perm: "contacts:view" },
  { href: "/inventory/products", label: "المواد", perm: "products:view" }, { href: "/inventory/stock", label: "المخزون", perm: "products:view" },
  { href: "/inventory/transfers", label: "تحويل المخزون", perm: "stock_transfer:view" }, { href: "/inventory/counts", label: "الجرد", perm: "inventory_count:view" },
  { href: "/expenses", label: "المصاريف", perm: "expense:view" }, { href: "/payroll", label: "الرواتب", perm: "payroll:view" }, { href: "/capital", label: "رأس المال والسحوبات", perm: "capital:view" },
  { href: "/partners", label: "الشراكة والأرباح", perm: "profit_settlement:view" },
  { href: "/accounting", label: "المحاسبة", perm: "journal:view" }, { href: "/accounting/opening", label: "الأرصدة الافتتاحية", perm: "opening_balance:view" }, { href: "/accounting/periods", label: "إقفال الفترات", perm: "period_close:view" },
  { href: "/sync", label: "المزامنة والعمل أوفلاين" }, { href: "/settings/company", label: "الشركة" }, { href: "/settings/fx", label: "أسعار الصرف", perm: "fx_rate:view" },
  { href: "/settings/users", label: "المستخدمون والصلاحيات", owner: true }, { href: "/settings/security", label: "الأمان (2FA)", owner: true }, { href: "/settings/audit", label: "سجل التدقيق", perm: "audit:view" },
];

export default function Shell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null); const path = usePathname(); const off = useOffline(); const [fromCache, setFromCache] = useState(false); const [pin, setPin] = useState(""); const [pinErr, setPinErr] = useState(""); const [update, setUpdate] = useState<ServiceWorkerRegistration | null>(null);
  // The identity/permission list is not secret (the server re-checks every request). It is cached so the shell can open offline.
  const loadMe = useCallback(async () => {
    try {
      const r = await api<Me & { csrf: string }>("/api/auth/me"); setCsrf(r.csrf); setMe(r); setFromCache(false);
      try { localStorage.setItem("erp-me", JSON.stringify({ companyId: r.companyId, user: r.user, permissions: r.permissions })); } catch { /* storage disabled */ }
      const v = await vaultStatus().catch(() => null);                                    // another user on this device: never keep their offline data
      if (v?.initialized && v.userId && v.userId !== r.user.username) await wipeVault().catch(() => {});
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { localStorage.removeItem("erp-me"); window.location.href = "/login"; return; }
      try { const c = JSON.parse(localStorage.getItem("erp-me") ?? "null"); if (c) { setMe(c); setFromCache(true); return; } } catch { /* ignore */ }
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
  if (!me) return <main className="login"><p>جارٍ التحميل…</p></main>;
  const items = NAV.filter((n) => (!n.owner || me.user.isOwner) && (!n.perm || can(me, n.perm)));
  const nav = items.map((n) => <Link key={n.href} href={n.href} aria-current={path === n.href || (n.href !== "/" && path.startsWith(n.href + "/")) ? "page" : undefined}>{n.label}</Link>);
  return (
    <MeCtx.Provider value={me}>
      <div className="shell">
        <nav className="side" aria-label="القائمة الرئيسية"><strong style={{ padding: "8px 12px" }}>النظام المحاسبي</strong>{nav}</nav>
        <div className="main">
          <div className="status">
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
        <nav className="tabbar" aria-label="تنقل سريع">{items.slice(0, 4).map((n) => <Link key={n.href} href={n.href}>{n.label}</Link>)}</nav>
      </div>
    </MeCtx.Provider>
  );
}
