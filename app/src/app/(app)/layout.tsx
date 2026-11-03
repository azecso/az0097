"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api, setCsrf } from "@/lib/client";
import { can, MeCtx, type Me } from "@/components/me";


const NAV = [
  { href: "/", label: "لوحة التحكم" },
  { href: "/sales", label: "المبيعات", perm: "sales:view" }, { href: "/purchases", label: "المشتريات", perm: "purchase:view" }, { href: "/cash", label: "النقدية والعهدة", perm: "voucher:view" }, { href: "/contacts", label: "العملاء والموردون", perm: "contacts:view" },
  { href: "/inventory/products", label: "المواد", perm: "products:view" }, { href: "/inventory/stock", label: "المخزون", perm: "products:view" },
  { href: "/inventory/transfers", label: "تحويل المخزون", perm: "stock_transfer:view" }, { href: "/inventory/counts", label: "الجرد", perm: "inventory_count:view" },
  { href: "/accounting", label: "المحاسبة", perm: "journal:view" },
  { href: "/settings/company", label: "الشركة" }, { href: "/settings/fx", label: "أسعار الصرف", perm: "fx_rate:view" },
  { href: "/settings/users", label: "المستخدمون والصلاحيات", owner: true }, { href: "/settings/audit", label: "سجل التدقيق", perm: "audit:view" },
];

export default function Shell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null); const [online, setOnline] = useState(true); const path = usePathname();
  useEffect(() => {
    api<Me & { csrf: string }>("/api/auth/me").then((r) => { setCsrf(r.csrf); setMe(r); }).catch(() => { window.location.href = "/login"; });
    const on = () => setOnline(true), off = () => setOnline(false);
    setOnline(navigator.onLine); window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
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
            <span><span className={online ? "dot" : "dot off"} />{online ? "متصل" : "غير متصل"}</span>
            <span>{me.user.displayName}{me.user.isOwner ? " (المالك)" : ""}</span>
            <button onClick={async () => { await api("/api/auth/logout", { method: "POST" }).catch(() => {}); window.location.href = "/login"; }}>خروج</button>
          </div>
          {children}
        </div>
        <nav className="tabbar" aria-label="تنقل سريع">{items.slice(0, 4).map((n) => <Link key={n.href} href={n.href}>{n.label}</Link>)}</nav>
      </div>
    </MeCtx.Provider>
  );
}
