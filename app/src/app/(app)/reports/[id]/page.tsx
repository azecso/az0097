"use client";
import { Suspense, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useLoad } from "@/components/ui";
import { useRefList } from "@/lib/offline/use";
import { fmtCell, type RCol, type RResult } from "@/lib/report-format";

interface Opt { id: string; name: string; code?: string; kind?: string }
const LABEL: Record<string, string> = { from: "من", to: "إلى", asOf: "حتى تاريخ", account: "رمز الحساب", currency: "العملة", partyId: "الجهة", productId: "المادة", locationId: "الموقع" };
function Inner() {
  const { id } = useParams<{ id: string }>(); const sp = useSearchParams(); const router = useRouter(); const qs = sp.toString();
  const res = useLoad<RResult | null>(`/api/reports2/${id}${qs ? `?${qs}` : ""}`, null); const r = res.data;
  const contacts = useRefList<Opt>("contacts", "/api/contacts").data, prods = useRefList<Opt>("products", "/api/products").data;
  const set = (k: string, v: string) => { const p = new URLSearchParams(sp); if (v) p.set(k, v); else p.delete(k); router.replace(`/reports/${id}?${p}`); };
  const parties = useMemo(() => contacts.filter((c) => (id === "customers" ? c.kind !== "SUPPLIER" : id === "suppliers" ? c.kind !== "CUSTOMER" : true)), [contacts, id]);
  return (<>
    <h1>{r?.title ?? "تقرير"}</h1>
    {r && <p><small><b>التعريف:</b> {r.definition}</small></p>}
    <div className="card row">
      {r?.filterKeys.map((k) => <div key={k}><label htmlFor={`f-${k}`}>{LABEL[k] ?? k}</label>
        {k === "from" || k === "to" || k === "asOf" ? <input id={`f-${k}`} type="date" value={sp.get(k) ?? ""} onChange={(e) => set(k, e.target.value)} />
          : k === "partyId" ? <select id={`f-${k}`} value={sp.get(k) ?? ""} onChange={(e) => set(k, e.target.value)}><option value="">الكل</option>{parties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          : k === "productId" ? <select id={`f-${k}`} value={sp.get(k) ?? ""} onChange={(e) => set(k, e.target.value)}><option value="">الكل</option>{prods.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select>
          : k === "currency" ? <select id={`f-${k}`} value={sp.get(k) ?? ""} onChange={(e) => set(k, e.target.value)}><option value="">الكل</option><option>IQD</option><option>USD</option></select>
          : <input id={`f-${k}`} value={sp.get(k) ?? ""} onChange={(e) => set(k, e.target.value)} dir="ltr" />}</div>)}
      <a className="btn" href={`/api/export-report/${id}${qs ? `?${qs}` : ""}`}>⬇ Excel</a><a className="btn" href={`/print/fin/${id}${qs ? `?${qs}` : ""}`} target="_blank" rel="noreferrer">🖨 طباعة / PDF</a></div>
    {res.err && <div className="msg err">{res.err}</div>}
    {r && <div className="card cards-as-list" style={{ marginTop: 12 }}>
      {r.notes.length > 0 && <p><small>{r.notes.join(" • ")}</small></p>}
      <table><thead><tr>{r.columns.map((c: RCol) => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>{r.rows.map((row, i) => <tr key={i} style={row.bold ? { fontWeight: 700 } : undefined}>{r.columns.map((c: RCol) => { const v = fmtCell(row, c); const href = c.href ? row[c.href] : null;
          return <td key={c.key}><span className={c.kind && c.kind !== "text" ? "num" : ""}>{href ? <Link href={href}>{v}</Link> : v}</span></td>; })}</tr>)}
          {r.rows.length === 0 && <tr><td colSpan={r.columns.length}>لا توجد بيانات ضمن هذه الفلاتر</td></tr>}
          {r.totals.map((t, i) => <tr key={`t${i}`} style={{ fontWeight: 700 }}>{r.columns.map((c: RCol) => <td key={c.key}><span className={c.kind && c.kind !== "text" ? "num" : ""}>{fmtCell(t, c)}</span></td>)}</tr>)}</tbody></table></div>}
  </>);
}
export default function ReportPage() { return <Suspense fallback={null}><Inner /></Suspense>; }
