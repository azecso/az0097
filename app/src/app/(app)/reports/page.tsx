"use client";
import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { money } from "@/lib/client";
import { useRefList } from "@/lib/offline/use";
import { MsgBox, useLoad } from "@/components/ui";
import { GROUP_LABEL, TYPE_TITLE, apiOf, colsOf, exportOf, type RType } from "@/lib/report-config";

interface Opt { id: string; name: string; code?: string; kind?: string }
const TYPES = (Object.keys(TYPE_TITLE) as RType[]).filter((t) => t !== "customers");            // customer summary moved to the per-currency statement report
const FIN: [string, string][] = [["trial-balance", "ميزان المراجعة"], ["ledger?account=1110", "الأستاذ العام"], ["profit-loss", "الأرباح والخسائر"], ["balance-sheet", "المركز المالي"], ["customers", "كشف حسابات العملاء"], ["suppliers", "كشف حسابات الموردين"], ["inventory-movement", "حركة المخزون"], ["cash-movement", "حركة النقد والعهدة"], ["profit-statement", "كشف الأرباح والشركاء"], ["outside-batches", "دفعات الربح خارج التوزيع"], ["outside-sales", "مبيعات الربح خارج التوزيع"]];
const STATUS_AR: Record<string, string> = { PAID: "مسدّد بالكامل", PARTIAL: "مسدّد جزئياً", UNPAID: "غير مسدّد" };
const cell = (v: unknown, kind?: string) => (typeof v === "string" && STATUS_AR[v] ? STATUS_AR[v] : v === null || v === undefined || v === "" ? "—" : kind === "money" ? money(v as string) : kind === "qty" ? Number(v).toLocaleString("en-US", { maximumFractionDigits: 4 }) : String(v));

function Inner() {
  const tab = useSearchParams().get("tab"); const [type, setType] = useState<RType>((TYPES as string[]).includes(tab ?? "") ? (tab as RType) : "sales"); const [group, setGroup] = useState("invoice"); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [party, setParty] = useState(""); const [product, setProduct] = useState(""); const [overdue, setOverdue] = useState(false); const [summary, setSummary] = useState(false);
  const contacts = useRefList<Opt>("contacts", "/api/contacts").data; const prods = useRefList<Opt>("products", "/api/products").data;
  const wantCustomer = type === "sales" || type === "debtors" || type === "customers" || type === "external"; const parties = contacts.filter((c) => (wantCustomer ? c.kind !== "SUPPLIER" : c.kind !== "CUSTOMER"));
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (type === "sales" || type === "purchases") { p.set("group", group); if (from) p.set("from", from); if (to) p.set("to", to); if (party) p.set("partyId", party); if (product) p.set("productId", product); }
    else if (type === "movement") { if (product) p.set("productId", product); if (from) p.set("from", from); if (to) p.set("to", to); }
    else if (type === "customers") { if (party) p.set("partyId", party); }
    else if (type === "external") { if (from) p.set("from", from); if (to) p.set("to", to); if (party) p.set("partyId", party); }
    else { if (party) p.set("partyId", party); if (overdue) p.set("overdue", "1"); if (summary) p.set("summary", "1"); }
    return p.toString();
  }, [type, group, from, to, party, product, overdue, summary]);
  const ready = type !== "movement" || !!product;
  const res = useLoad<any>(ready ? apiOf(type, qs) : null, null);
  const data = res.data; const cols = colsOf(type, group, summary); const rows: any[] = data?.rows ?? [];
  const tot = data?.totals;
  const printQs = new URLSearchParams(qs); printQs.set("type", type); if (type === "debtors" || type === "creditors") printQs.delete("side");
  return (<>
    <h1>التقارير</h1>
    <div className="card row" aria-label="التقارير المالية"><strong>مالية ومحاسبية:</strong>{FIN.map(([id, t]) => <a key={id} className="btn" href={`/reports/${id}`}>{t}</a>)}<a className="btn" href="/capital/returns">إرجاع رأس المال (معلوماتي)</a></div>
    <div className="card row" role="tablist">{TYPES.map((t) => <button key={t} role="tab" aria-selected={t === type} className={t === type ? "primary" : ""} onClick={() => { setType(t); setParty(""); }}>{TYPE_TITLE[t]}</button>)}</div>
    <div className="card row" style={{ marginTop: 12 }}>
      {(type === "sales" || type === "purchases") && <div><label htmlFor="g">طريقة العرض</label><select id="g" value={group} onChange={(e) => setGroup(e.target.value)}>{Object.entries(GROUP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>}
      {type !== "debtors" && type !== "creditors" && type !== "customers" && <><div><label htmlFor="f">من تاريخ</label><input id="f" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div><div><label htmlFor="t">إلى تاريخ</label><input id="t" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div></>}
      {type !== "movement" && <div><label htmlFor="p">{wantCustomer ? "العميل" : "المورد"}</label><select id="p" value={party} onChange={(e) => setParty(e.target.value)}><option value="">الكل</option>{parties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
      {(type === "sales" || type === "purchases" || type === "movement") && <div><label htmlFor="m">المادة{type === "movement" ? " (مطلوبة)" : ""}</label><select id="m" value={product} onChange={(e) => setProduct(e.target.value)}><option value="">{type === "movement" ? "اختر…" : "الكل"}</option>{prods.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}</select></div>}
      {(type === "debtors" || type === "creditors") && <><label><input type="checkbox" checked={summary} onChange={(e) => setSummary(e.target.checked)} /> ملخص لكل جهة</label><label><input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> المتأخر فقط</label></>}
      {ready && <><a className="btn" href={exportOf(type, qs)}>⬇ Excel</a><a className="btn" href={`/print/analytics?${printQs}`} target="_blank" rel="noreferrer">🖨 طباعة / PDF</a></>}
    </div>
    <MsgBox msg={res.err ? { t: "err", m: res.err } : null} />
    {!ready ? <p>اختر المادة لعرض حركتها.</p> : <div className="card cards-as-list" style={{ marginTop: 12 }}>
      {type === "movement" && data?.product && <p><strong>{data.product.code} — {data.product.name}</strong> · رصيد افتتاحي: <span className="num">{cell(data.opening.qty, "qty")}</span> {data.product.baseUom} · الوارد <span className="num">{cell(data.totals.qtyIn, "qty")}</span> · الصادر <span className="num">{cell(data.totals.qtyOut, "qty")}</span> · الختامي <span className="num">{cell(data.closing, "qty")}</span></p>}
      <table><thead><tr>{cols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={r.key ?? r.docNo ?? (r.partyId ? r.partyId + r.currency : i)} className={r.status === "PAID" ? "paidrow" : undefined}>{cols.map((c) => <td key={c.key}><span className={c.kind ? "num" : ""}>{cell(r[c.key], c.kind)}</span></td>)}</tr>)}
          {rows.length === 0 && <tr><td colSpan={cols.length}>لا توجد بيانات ضمن هذه الفلاتر</td></tr>}
          {(type === "sales" || type === "purchases") && tot && rows.length > 0 && <tr style={{ fontWeight: 700 }}>{cols.map((c, i) => <td key={c.key}>{i === 0 ? "الإجمالي" : c.key in tot ? <span className="num">{cell(tot[c.key], c.kind)}</span> : ""}</td>)}</tr>}
        </tbody></table>
      {type === "external" && tot && !Array.isArray(tot) && <p>الإجمالي ({tot.count} سند): مستحصل نقداً <strong className="num">{money(tot.cash)}</strong> · موزَّع خارج النظام <strong className="num">{money(tot.external)}</strong> (لكل شريك <span className="num">{money(tot.perPartner)}</span>)</p>}
      {type === "customers" && tot && Array.isArray(tot) && <p>الإجمالي: {tot.map((t: any) => <strong key={t.currency}>مبيعات <span className="num">{money(t.sales)}</span> · مسدَّد <span className="num">{money(t.paid)}</span> · متبقٍ <span className="num">{money(t.remaining)}</span> {t.currency}&nbsp;&nbsp;</strong>)}</p>}
      {(type === "debtors" || type === "creditors") && Array.isArray(tot) && <p>الإجمالي: {tot.map((t: any) => <strong key={t.currency}><span className="num">{money(t.total)}</span> {t.currency}&nbsp;&nbsp;</strong>)}</p>}
      {(type === "sales" || type === "purchases") && <p style={{ fontSize: 12 }}>المبالغ بالدينار (القيمة الأساسية المسجّلة عند الترحيل){type === "purchases" && group === "product" ? " · مصاريف الشراء والمرتجعات غير موزعة على المواد" : ""}.</p>}
    </div>}
  </>);
}
export default function Reports() { return <Suspense fallback={null}><Inner /></Suspense>; }
