"use client";
import { useState } from "react";
import Link from "next/link";
import Decimal from "decimal.js";
import { money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { useLoad } from "@/components/ui";

interface Dash {
  range: { from: string; to: string }; previousRange: { from: string; to: string };
  balances: Record<string, string>; period: Record<string, string>; previous: Record<string, string>; change: Record<string, string | null>;
  distributable: { eligibleProfit: string; deductions: string; distributable: string; ownerShare: string; partnerShare: string; lossCarriedIn: string; lossCarriedOut: string } | null;
  liquidity: { cash: string; committed: string; available: string };
  series: { month: string; revenue: string; expenses: string; cogs: string }[];
  topProducts: { code: string; name: string; qty: string; revenue: string; cost: string }[]; topCustomers: { name: string; revenue: string }[]; expensesByCategory: { name: string | null; amount: string }[];
  integrity: { equationDifference: string; balanced: boolean; inventoryReconciled: boolean };
}
interface Alert { level: "high" | "medium" | "info"; code: string; message: string; amount?: string }

const first = () => `${today().slice(0, 8)}01`;
function Delta({ v }: { v: string | null | undefined }) { if (v === null || v === undefined) return <small className="badge">لا مقارنة</small>; const n = Number(v); return <small className="badge" style={{ color: n >= 0 ? "var(--accent)" : "var(--danger)" }}>{n >= 0 ? "▲" : "▼"} <span className="num">{Math.abs(n)}%</span> عن الفترة السابقة</small>; }
function Card({ label, value, sub, delta, href }: { label: string; value: string | undefined; sub?: string; delta?: string | null; href?: string }) {
  const body = <div className="card stat" style={href ? { cursor: "pointer" } : undefined}><div className="label">{label}</div><div className="value"><span className="num">{money(value)}</span></div>{sub && <small style={{ color: "var(--muted)" }}>{sub}</small>}{delta !== undefined && <div><Delta v={delta} /></div>}</div>;
  return href ? <Link href={href} aria-label={`تفاصيل: ${label}`} style={{ textDecoration: "none", color: "inherit", display: "block" }}>{body}<small style={{ color: "var(--accent)" }}>اضغط للتفاصيل ←</small></Link> : body;
}

function Lines({ data }: { data: Dash["series"] }) {
  const W = 640, H = 200, pad = 28; const max = Math.max(1, ...data.flatMap((m) => [Number(m.revenue), Number(m.expenses) + Number(m.cogs)]));
  const x = (i: number) => pad + (i * (W - 2 * pad)) / Math.max(1, data.length - 1), y = (v: number) => H - pad - (v / max) * (H - 2 * pad);
  const path = (f: (m: Dash["series"][0]) => number) => data.map((m, i) => `${i ? "L" : "M"}${x(i)},${y(f(m))}`).join(" ");
  return (<svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="الإيرادات مقابل التكاليف والمصاريف لآخر 12 شهراً" style={{ width: "100%", height: "auto" }}>
    {[0, 0.5, 1].map((t) => <line key={t} x1={pad} x2={W - pad} y1={y(max * t)} y2={y(max * t)} stroke="var(--border)" />)}
    <path d={path((m) => Number(m.revenue))} fill="none" stroke="var(--accent)" strokeWidth="3" /><path d={path((m) => Number(m.expenses) + Number(m.cogs))} fill="none" stroke="var(--danger)" strokeWidth="3" strokeDasharray="6 4" />
    {data.map((m, i) => <g key={m.month}><circle cx={x(i)} cy={y(Number(m.revenue))} r="3.5" fill="var(--accent)"><title>{`${m.month} إيراد ${money(m.revenue)}`}</title></circle>{i % 2 === 0 && <text x={x(i)} y={H - 8} fontSize="10" textAnchor="middle" fill="var(--muted)" direction="ltr">{m.month.slice(2)}</text>}</g>)}
  </svg>);
}
function Bars({ rows, unit }: { rows: { label: string; value: number; note?: string }[]; unit?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (<div style={{ display: "grid", gap: 8 }}>{rows.map((r) => <div key={r.label}><div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}><span>{r.label}</span><span className="num">{money(r.value)} {unit}{r.note ? ` • ${r.note}` : ""}</span></div>
    <div style={{ background: "var(--surface-2)", borderRadius: 8, height: 10 }}><div style={{ width: `${(r.value / max) * 100}%`, background: "var(--accent)", height: 10, borderRadius: 8 }} /></div></div>)}{rows.length === 0 && <span style={{ color: "var(--muted)" }}>لا بيانات</span>}</div>);
}

export default function Dashboard() {
  const me = useMe(); const [range, setRange] = useState({ from: first(), to: today() });
  const allowed = can(me, "report:view"); const { data, err } = useLoad<Dash | null>(allowed ? `/api/dashboard?from=${range.from}&to=${range.to}` : null, null); const al = useLoad<Alert[]>(allowed ? "/api/alerts" : null, []).data;
  if (!allowed) return <><h1>لوحة التحكم المالية</h1><p>لا تملك صلاحية عرض التقارير.</p></>;
  const preset = (k: string) => { const t = new Date(); const y = t.getUTCFullYear(), m = t.getUTCMonth();
    if (k === "month") setRange({ from: first(), to: today() }); if (k === "last") setRange({ from: new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10), to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) });
    if (k === "year") setRange({ from: `${y}-01-01`, to: today() }); };
  return (<>
    <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, alignItems: "center" }}><h1>لوحة التحكم المالية</h1><span className="badge">IQD</span></div>
    <div className="card row"><div><label htmlFor="f">من</label><input id="f" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></div><div><label htmlFor="t">إلى</label><input id="t" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button onClick={() => preset("month")}>هذا الشهر</button><button onClick={() => preset("last")}>الشهر الماضي</button><button onClick={() => preset("year")}>هذه السنة</button></div></div>
    {err && <div className="msg err">{err}</div>}
    {al.length > 0 && <div style={{ display: "grid", gap: 6, marginTop: 12 }}>{al.map((a) => <div key={a.code} className={`msg ${a.level === "high" ? "err" : ""}`} role="status">{a.level === "high" ? "⛔ " : a.level === "medium" ? "⚠ " : "ℹ "}{a.message}{a.amount ? ` — ${money(a.amount)}` : ""}</div>)}</div>}
    {data && <>
      {!data.integrity.balanced && <div className="msg err" role="alert">⛔ معادلة الميزانية غير متوازنة (فرق {money(data.integrity.equationDifference)}) — راجع فوراً</div>}
      <h2>المركز المالي الآن</h2>
      <div className="grid">
        <Card href="/capital" label="رأس المال" value={data.balances.capital} /><Card href="/cash/movements" label="رصيد الصندوق" value={data.balances.mainCash} sub={`عهدة الشريك (ذمة منفصلة): ${money(data.balances.partnerCustodyCash)}`} />
        <Card href="/inventory/stock" label="قيمة المخزون" value={new Decimal(data.balances.inventoryMain ?? 0).plus(data.balances.inventoryPartner ?? 0).toString()} sub={`الرئيسي ${money(data.balances.inventoryMain)} • عند الشريك ${money(data.balances.inventoryPartner)}`} />
        <Card href="/reports?tab=debtors" label="ديون العملاء (الصافي)" value={new Decimal(data.balances.receivables ?? 0).minus(data.balances.customerCredit ?? 0).toString()} sub={`إجمالي الفواتير ${money(data.balances.receivables)}${Number(data.balances.customerCredit) > 0 ? ` − دفعات غير مخصّصة ${money(data.balances.customerCredit)}` : ""} · المتأخر ${money(data.balances.overdueReceivables)}`} /><Card href="/reports?tab=creditors" label="ديون الموردين" value={data.balances.supplierPayables} sub={`رواتب ومصاريف مستحقة: ${money(data.balances.accruedLiabilities)}`} />
        <Card href="/profits" label="الربح القابل للتوزيع الآن" value={data.distributable?.distributable ?? "0"} sub={data.distributable ? `المالك ${money(data.distributable.ownerShare)} • الشريك ${money(data.distributable.partnerShare)}` : undefined} /></div>
      <h2>أداء الفترة ({data.range.from} → {data.range.to})</h2>
      <div className="grid">
        <Card href="/reports?tab=sales" label="صافي المبيعات" value={data.period.revenue} delta={data.change.revenue} /><Card href="/reports?tab=sales" label="تكلفة البضاعة المباعة" value={data.period.cogs} /><Card href="/reports?tab=sales" label="إجمالي الربح" value={data.period.grossProfit} />
        <Card href="/expenses" label="المصاريف المستحقة" value={data.period.expenses} delta={data.change.expenses} /><Card label="صافي ربح الفترة (استحقاق)" value={data.period.netProfit} delta={data.change.netProfit} /><Card label="التحصيل" value={data.period.collections} delta={data.change.collections} /></div>
      <div className="grid" style={{ marginTop: 12 }}>
        <div className="card" style={{ gridColumn: "1 / -1" }}><h2 style={{ marginTop: 0 }}>الإيرادات مقابل التكاليف والمصاريف (12 شهراً)</h2><Lines data={data.series} /><small style={{ color: "var(--muted)" }}>— خط متصل: الإيراد • خط متقطع: التكلفة + المصاريف</small></div>
        <div className="card"><h2 style={{ marginTop: 0 }}>أفضل الأصناف</h2><Bars unit="" rows={data.topProducts.map((p) => ({ label: `${p.code} — ${p.name}`, value: Number(p.revenue), note: `ربح ${money(String(Number(p.revenue) - Number(p.cost)))}` }))} /></div>
        <div className="card"><h2 style={{ marginTop: 0 }}>أفضل العملاء</h2><Bars rows={data.topCustomers.map((c) => ({ label: c.name, value: Number(c.revenue) }))} /></div>
        <div className="card"><h2 style={{ marginTop: 0 }}>المصاريف حسب التصنيف</h2><Bars rows={data.expensesByCategory.map((c) => ({ label: c.name ?? "أخرى", value: Number(c.amount) }))} /></div></div>
      <h2>السيولة والالتزامات</h2>
      <div className="card"><span>النقد المتاح للتوزيع = نقد <span className="num">{money(data.liquidity.cash)}</span> − التزامات مقررة <span className="num">{money(data.liquidity.committed)}</span> = <strong className="num">{money(data.liquidity.available)}</strong></span>
        {data.distributable && Number(data.distributable.lossCarriedOut) > 0 && <p>خسارة مرحّلة للتسوية القادمة: <span className="num">{money(data.distributable.lossCarriedOut)}</span> (تُغطى من الأرباح اللاحقة قبل أي توزيع)</p>}
        <p style={{ color: "var(--muted)" }}>سلامة الدفاتر: معادلة الميزانية {data.integrity.balanced ? "✔ صفر فرق" : "⚠"} • مطابقة المخزون مع الدفتر {data.integrity.inventoryReconciled ? "✔" : "⚠"}</p></div></>}
  </>);
}
