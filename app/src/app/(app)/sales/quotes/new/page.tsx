"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, today } from "@/lib/client";
import { createDraft, useRefList } from "@/lib/offline/use";
import { MsgBox, useAction, useLoad } from "@/components/ui";
import { PickOrCreate } from "@/components/pick";

interface Prod { id: string; code: string; name: string; baseUom: string; uoms: { uom: string }[]; defaultSalePrice: string | null; defaultCurrency?: string | null } interface Contact { id: string; name: string }
export default function NewQuote() {
  const router = useRouter(); const { msg, busy, run, setMsg } = useAction(); const [newProds, setNewProds] = useState<Prod[]>([]); const prodsLoaded = useRefList<Prod>("products", "/api/products").data, cust = useRefList<Contact & { kind?: string }>("contacts", "/api/contacts?kind=CUSTOMER", (c) => c.kind !== "SUPPLIER").data; const prods = [...prodsLoaded, ...newProds];
  const [cur, setCur] = useState("IQD"); const [lines, setLines] = useState([{ productId: "", uom: "", qty: "", unitPrice: "", lineDiscount: "" }]);
  const upd = (i: number, k: string, v: string) => setLines((ls) => ls.map((l, j) => j !== i ? l : { ...l, [k]: v, ...(k === "productId" ? { uom: prods.find((p) => p.id === v)?.baseUom ?? "", unitPrice: (() => { const p = prods.find((x) => x.id === v); return p?.defaultSalePrice && (p.defaultCurrency ?? "IQD") === cur ? p.defaultSalePrice : ""; })() } : {}) }));
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const r = await run(() => createDraft({ entityType: "sales_quote", endpoint: "/api/sales-quotes", title: "عرض سعر (أوفلاين)", payload: { customerId: String(f.get("customer")), docDate: String(f.get("date")), validUntil: String(f.get("valid") ?? "") || null, currency: cur, exchangeRate: cur === "USD" ? String(f.get("rate") || "") || null : null,
      discount: String(f.get("disc") || "0"), terms: String(f.get("terms") ?? "") || null, notes: String(f.get("notes") ?? "") || null, lines: lines.map((l) => ({ ...l, lineDiscount: l.lineDiscount || "0" })) } }), "حُفظت المسودة");
    if (r?.mode === "queued") { setMsg({ t: "ok", m: "📴 حُفظت على جهازك مشفّرة وبانتظار المزامنة — ستُرسل تلقائياً عند عودة الاتصال (تابعها من «المزامنة»)." }); setLines([{ productId: "", uom: "", qty: "", unitPrice: "", lineDiscount: "" }]); } else if (r) router.push("/sales/quotes");
  }
  return (<><h1>عرض سعر جديد</h1>
    <form className="card" onSubmit={save} style={{ display: "grid", gap: 12 }}>
      <div className="row"><div><label htmlFor="c">العميل</label><PickOrCreate kind="customer" filterText id="c" name="customer" required options={cust.map((c) => ({ id: c.id, label: c.name }))} /></div>
        <div><label htmlFor="d">التاريخ</label><input id="d" name="date" type="date" defaultValue={today()} /></div><div><label htmlFor="v">صالح حتى</label><input id="v" name="valid" type="date" /></div>
        <div><label htmlFor="cu">العملة</label><select id="cu" value={cur} onChange={(e) => { const next = e.target.value; if (lines.some((l) => l.unitPrice) && !window.confirm(`تغيير العملة إلى ${next} سيمسح الأسعار المُدخلة (لا تُحوَّل تلقائياً). متابعة؟`)) return; setLines((ls) => ls.map((l) => ({ ...l, unitPrice: "" }))); setCur(next); }}><option>IQD</option><option>USD</option></select></div>
        {cur === "USD" && <div><label htmlFor="r">سعر الصرف</label><input id="r" name="rate" dir="ltr" inputMode="decimal" /></div>}</div>
      {lines.map((l, i) => { const p = prods.find((x) => x.id === l.productId); return <div className="row card" key={i}>
        <div><label>المادة</label><PickOrCreate kind="product" filterText options={prods.map((x) => ({ id: x.id, label: `${x.code} — ${x.name}` }))} value={l.productId} onChange={(v) => upd(i, "productId", v)} required onCreated={(o) => { void api<Prod[]>("/api/products").then((all) => { const p = all.find((x) => x.id === o.id); if (p) { setNewProds((x) => [...x, p]); upd(i, "uom", p.baseUom); } }); }} /></div>
        <div><label>الوحدة</label><select value={l.uom} onChange={(e) => upd(i, "uom", e.target.value)}>{p && [p.baseUom, ...p.uoms.map((u) => u.uom)].map((u) => <option key={u}>{u}</option>)}</select></div>
        <div><label>الكمية</label><input value={l.qty} required dir="ltr" inputMode="decimal" onChange={(e) => upd(i, "qty", e.target.value)} /></div>
        <div><label>السعر</label><input value={l.unitPrice} required dir="ltr" inputMode="decimal" onChange={(e) => upd(i, "unitPrice", e.target.value)} /></div>
        <div><label>خصم البند</label><input value={l.lineDiscount} dir="ltr" inputMode="decimal" onChange={(e) => upd(i, "lineDiscount", e.target.value)} /></div></div>; })}
      <button type="button" onClick={() => setLines([...lines, { productId: "", uom: "", qty: "", unitPrice: "", lineDiscount: "" }])}>+ بند</button>
      <div className="row"><div><label htmlFor="ds">خصم على العرض</label><input id="ds" name="disc" dir="ltr" inputMode="decimal" /></div><div><label htmlFor="tm">الشروط</label><input id="tm" name="terms" /></div><div><label htmlFor="nt">ملاحظات</label><input id="nt" name="notes" /></div></div>
      <MsgBox msg={msg} /><button className="primary" disabled={busy}>حفظ كمسودة</button></form></>);
}
