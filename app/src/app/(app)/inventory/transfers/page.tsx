"use client";
import { useState } from "react";
import { api, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, StatusBadge, useAction, useLoad } from "@/components/ui";

interface T { id: string; draftRef: string; docNo: string | null; docDate: string; from: string; to: string; status: string }
interface Prod { id: string; code: string; name: string; baseUom: string; uoms: { uom: string }[] } interface Loc { id: string; name: string }
export default function Transfers() {
  const me = useMe(); const list = useLoad<T[]>("/api/stock-transfers", []); const prods = useLoad<Prod[]>("/api/products", []).data, locs = useLoad<Loc[]>("/api/locations", []).data;
  const { msg, busy, run } = useAction(list.reload); const [reason, setReason] = useState("");
  const [lines, setLines] = useState([{ productId: "", uom: "", qty: "" }]);
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await run(() => api("/api/stock-transfers", { method: "POST", body: { docDate: String(f.get("date")), fromLocationId: String(f.get("from")), toLocationId: String(f.get("to")), lines } }), "حُفظت مسودة التحويل");
  }
  return (<>
    <h1>تحويل المخزون بين الموقعين</h1>
    <p>التحويل الداخلي لا يُنشئ مبيعات ولا إيراداً ولا تكلفة بضاعة مباعة؛ تنتقل الطبقات بتكلفتها وتاريخ استلامها الأصلي.</p>
    {can(me, "stock_transfer:create") && <form className="card" onSubmit={create} style={{ display: "grid", gap: 12 }}>
      <div className="row"><div><label htmlFor="d">التاريخ</label><input id="d" name="date" type="date" defaultValue={today()} /></div>
        <div><label htmlFor="f">من</label><select id="f" name="from">{locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
        <div><label htmlFor="t">إلى</label><select id="t" name="to" defaultValue={locs[1]?.id}>{locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div></div>
      {lines.map((l, i) => { const p = prods.find((x) => x.id === l.productId); return <div className="row" key={i}>
        <div><label>المادة</label><select value={l.productId} required onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, productId: e.target.value, uom: prods.find((q) => q.id === e.target.value)?.baseUom ?? "" } : x))}><option value="">اختر…</option>{prods.map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></div>
        <div><label>الوحدة</label><select value={l.uom} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, uom: e.target.value } : x))}>{p && [p.baseUom, ...p.uoms.map((u) => u.uom)].map((u) => <option key={u}>{u}</option>)}</select></div>
        <div><label>الكمية</label><input value={l.qty} required inputMode="decimal" dir="ltr" onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} /></div></div>; })}
      <button type="button" onClick={() => setLines([...lines, { productId: "", uom: "", qty: "" }])}>+ بند</button>
      <button className="primary" disabled={busy}>حفظ كمسودة</button></form>}
    <MsgBox msg={msg} />
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>من</th><th>إلى</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{list.data.map((t) => <tr key={t.id}><td><span className="num">{t.docNo ?? t.draftRef}</span></td><td><span className="num">{t.docDate}</span></td><td>{t.from}</td><td>{t.to}</td><td><StatusBadge s={t.status} /></td>
        <td>{t.status === "DRAFT" && can(me, "stock_transfer:approve") && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/stock-transfers/${t.id}/post`, { method: "POST" }), "تم ترحيل التحويل")}>ترحيل</button>}
          {t.status === "DRAFT" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/stock-transfers/${t.id}`, { method: "DELETE" }), "حُذفت المسودة")}>حذف</button>}
          {t.status === "POSTED" && can(me, "stock_transfer:cancel") && <><input aria-label="سبب العكس" placeholder="سبب العكس" value={reason} onChange={(e) => setReason(e.target.value)} style={{ maxWidth: 160 }} /><button className="danger" disabled={busy || reason.length < 3} onClick={() => run(() => api(`/api/stock-transfers/${t.id}/reverse`, { method: "POST", body: { reason } }), "تم العكس")}>عكس</button></>}</td></tr>)}
        {list.data.length === 0 && <tr><td colSpan={6}>لا توجد تحويلات</td></tr>}</tbody></table></div></>);
}
