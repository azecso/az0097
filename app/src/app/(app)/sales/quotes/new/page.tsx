"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, today } from "@/lib/client";
import { MsgBox, useAction, useLoad } from "@/components/ui";

interface Prod { id: string; code: string; name: string; baseUom: string; uoms: { uom: string }[]; defaultSalePrice: string | null } interface Contact { id: string; name: string }
export default function NewQuote() {
  const router = useRouter(); const { msg, busy, run } = useAction(); const prods = useLoad<Prod[]>("/api/products", []).data, cust = useLoad<Contact[]>("/api/contacts?kind=CUSTOMER", []).data;
  const [cur, setCur] = useState("IQD"); const [lines, setLines] = useState([{ productId: "", uom: "", qty: "", unitPrice: "", lineDiscount: "" }]);
  const upd = (i: number, k: string, v: string) => setLines((ls) => ls.map((l, j) => j !== i ? l : { ...l, [k]: v, ...(k === "productId" ? { uom: prods.find((p) => p.id === v)?.baseUom ?? "", unitPrice: prods.find((p) => p.id === v)?.defaultSalePrice ?? l.unitPrice } : {}) }));
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const r = await run(() => api<{ id: string }>("/api/sales-quotes", { method: "POST", body: { customerId: String(f.get("customer")), docDate: String(f.get("date")), validUntil: String(f.get("valid") ?? "") || null, currency: cur, exchangeRate: cur === "USD" ? String(f.get("rate") || "") || null : null,
      discount: String(f.get("disc") || "0"), terms: String(f.get("terms") ?? "") || null, notes: String(f.get("notes") ?? "") || null, lines: lines.map((l) => ({ ...l, lineDiscount: l.lineDiscount || "0" })) } }), "حُفظت المسودة");
    if (r) router.push("/sales/quotes");
  }
  return (<><h1>عرض سعر جديد</h1>
    <form className="card" onSubmit={save} style={{ display: "grid", gap: 12 }}>
      <div className="row"><div><label htmlFor="c">العميل</label><select id="c" name="customer" required><option value="">اختر…</option>{cust.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><label htmlFor="d">التاريخ</label><input id="d" name="date" type="date" defaultValue={today()} /></div><div><label htmlFor="v">صالح حتى</label><input id="v" name="valid" type="date" /></div>
        <div><label htmlFor="cu">العملة</label><select id="cu" value={cur} onChange={(e) => setCur(e.target.value)}><option>IQD</option><option>USD</option></select></div>
        {cur === "USD" && <div><label htmlFor="r">سعر الصرف</label><input id="r" name="rate" dir="ltr" inputMode="decimal" /></div>}</div>
      {lines.map((l, i) => { const p = prods.find((x) => x.id === l.productId); return <div className="row card" key={i}>
        <div><label>المادة</label><select value={l.productId} required onChange={(e) => upd(i, "productId", e.target.value)}><option value="">اختر…</option>{prods.map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></div>
        <div><label>الوحدة</label><select value={l.uom} onChange={(e) => upd(i, "uom", e.target.value)}>{p && [p.baseUom, ...p.uoms.map((u) => u.uom)].map((u) => <option key={u}>{u}</option>)}</select></div>
        <div><label>الكمية</label><input value={l.qty} required dir="ltr" inputMode="decimal" onChange={(e) => upd(i, "qty", e.target.value)} /></div>
        <div><label>السعر</label><input value={l.unitPrice} required dir="ltr" inputMode="decimal" onChange={(e) => upd(i, "unitPrice", e.target.value)} /></div>
        <div><label>خصم البند</label><input value={l.lineDiscount} dir="ltr" inputMode="decimal" onChange={(e) => upd(i, "lineDiscount", e.target.value)} /></div></div>; })}
      <button type="button" onClick={() => setLines([...lines, { productId: "", uom: "", qty: "", unitPrice: "", lineDiscount: "" }])}>+ بند</button>
      <div className="row"><div><label htmlFor="ds">خصم على العرض</label><input id="ds" name="disc" dir="ltr" inputMode="decimal" /></div><div><label htmlFor="tm">الشروط</label><input id="tm" name="terms" /></div><div><label htmlFor="nt">ملاحظات</label><input id="nt" name="notes" /></div></div>
      <MsgBox msg={msg} /><button className="primary" disabled={busy}>حفظ كمسودة</button></form></>);
}
