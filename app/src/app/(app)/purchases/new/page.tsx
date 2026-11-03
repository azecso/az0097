"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, today } from "@/lib/client";
import { MsgBox, useAction, useLoad } from "@/components/ui";

interface Prod { id: string; code: string; name: string; baseUom: string; uoms: { uom: string }[] }
interface Contact { id: string; name: string; kind: string }
interface Cash { id: string; name: string; currency: string; kind: string }
interface Loc { id: string; name: string; kind: string }
interface Charge { kind: string; description: string; amount: string; capitalize: boolean }
interface Line { productId: string; uom: string; qty: string; unitPrice: string; locationId: string }
export default function NewPurchase() {
  const router = useRouter(); const { msg, busy, run } = useAction();
  const prods = useLoad<Prod[]>("/api/products", []).data, sup = useLoad<Contact[]>("/api/contacts?kind=SUPPLIER", []).data;
  const cash = useLoad<Cash[]>("/api/cash-accounts", []).data, locs = useLoad<Loc[]>("/api/locations", []).data;
  const [cur, setCur] = useState("IQD"); const [type, setType] = useState("CASH");
  const policy = useLoad<{ landedCostPolicy: string } | null>("/api/company", null).data?.landedCostPolicy ?? "EXCLUDE";
  const [charges, setCharges] = useState<Charge[]>([]);
  const [lines, setLines] = useState<Line[]>([{ productId: "", uom: "", qty: "", unitPrice: "", locationId: "" }]);
  const upd = (i: number, k: keyof Line, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v, ...(k === "productId" ? { uom: prods.find((p) => p.id === v)?.baseUom ?? "" } : {}) } : l)));
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const r = await run(() => api<{ id: string }>("/api/purchases", { method: "POST", body: { supplierId: String(f.get("supplier")), docDate: String(f.get("date")), paymentType: type,
      cashAccountId: type === "CASH" ? String(f.get("cash")) : null, dueDate: type === "CREDIT" && f.get("due") ? String(f.get("due")) : null, currency: cur, exchangeRate: cur === "IQD" ? null : String(f.get("rate") || "") || null,
      supplierInvoiceNo: String(f.get("inv") ?? "") || null, lines: lines.map((l) => ({ productId: l.productId, uom: l.uom, qty: l.qty, unitPrice: l.unitPrice, locationId: l.locationId || null })), charges: charges.filter((c) => c.amount).map((c) => ({ kind: c.kind, description: c.description || null, amount: c.amount, capitalize: c.capitalize })) } }), "تم حفظ المسودة");
    if (r) router.push(`/purchases/${r.id}`);
  }
  return (<>
    <h1>فاتورة شراء جديدة</h1>
    <p>تُحفظ كمسودة، ولا يصدر رقمها النهائي ولا تدخل البضاعة للمخزون إلا عند الترحيل. سعر شراء المادة وحده يدخل تكلفة المخزون؛ النقل مصروف منفصل.</p>
    <form onSubmit={save} className="card" style={{ display: "grid", gap: 12 }}>
      <div className="row">
        <div><label htmlFor="s">المورد</label><select id="s" name="supplier" required><option value="">اختر…</option>{sup.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div><label htmlFor="d">التاريخ</label><input id="d" name="date" type="date" defaultValue={today()} required /></div>
        <div><label htmlFor="i">رقم فاتورة المورد</label><input id="i" name="inv" dir="ltr" /></div>
      </div>
      <div className="row">
        <div><label htmlFor="t">الدفع</label><select id="t" value={type} onChange={(e) => setType(e.target.value)}><option value="CASH">نقدي</option><option value="CREDIT">آجل</option></select></div>
        <div><label htmlFor="c">العملة</label><select id="c" value={cur} onChange={(e) => setCur(e.target.value)}><option>IQD</option><option>USD</option></select></div>
        {cur === "USD" && <div><label htmlFor="r">سعر الصرف (IQD لكل 1 USD) — اتركه فارغاً لسعر اليوم</label><input id="r" name="rate" inputMode="decimal" dir="ltr" /></div>}
        {type === "CASH" ? <div><label htmlFor="ca">الصندوق</label><select id="ca" name="cash" required>{cash.filter((c) => c.currency === cur && c.kind !== "PARTNER_CUSTODY").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          : <div><label htmlFor="du">تاريخ الاستحقاق</label><input id="du" name="due" type="date" /></div>}
      </div>
      <h2>البنود</h2>
      {lines.map((l, i) => { const p = prods.find((x) => x.id === l.productId); return (
        <div className="row card" key={i}>
          <div><label>المادة</label><select value={l.productId} onChange={(e) => upd(i, "productId", e.target.value)} required><option value="">اختر…</option>{prods.map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></div>
          <div><label>الوحدة</label><select value={l.uom} onChange={(e) => upd(i, "uom", e.target.value)}>{p && [p.baseUom, ...p.uoms.map((u) => u.uom)].map((u) => <option key={u}>{u}</option>)}</select></div>
          <div><label>الكمية</label><input value={l.qty} onChange={(e) => upd(i, "qty", e.target.value)} inputMode="decimal" dir="ltr" required /></div>
          <div><label>سعر الوحدة ({cur})</label><input value={l.unitPrice} onChange={(e) => upd(i, "unitPrice", e.target.value)} inputMode="decimal" dir="ltr" required /></div>
          <div><label>موقع الاستلام</label><select value={l.locationId} onChange={(e) => upd(i, "locationId", e.target.value)}><option value="">الرئيسي</option>{locs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
          {lines.length > 1 && <button type="button" className="danger" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>حذف البند</button>}
        </div>); })}
      <button type="button" onClick={() => setLines((ls) => [...ls, { productId: "", uom: "", qty: "", unitPrice: "", locationId: "" }])}>+ بند</button>
      <h2>تكاليف إضافية (نقل، تحميل، جمارك…)</h2>
      <p>اختر لكل بند: <strong>تُضاف إلى كلفة المخزون</strong> (تُوزَّع على مواد هذه الفاتورة بنسبة قيمتها) أو <strong>مصروف</strong>. الافتراضي حسب إعداد الشركة. المبلغ يُضاف إلى مستحق المورد.</p>
      {charges.map((c, i) => (<div className="row card" key={i}>
        <div><label>النوع</label><select value={c.kind} onChange={(e) => setCharges(charges.map((x, j) => j === i ? { ...x, kind: e.target.value } : x))}><option value="TRANSPORT">نقل</option><option value="LOADING">تحميل/تنزيل</option><option value="CUSTOMS">جمارك</option><option value="OTHER">أخرى</option></select></div>
        <div><label>المبلغ ({cur})</label><input value={c.amount} inputMode="decimal" dir="ltr" onChange={(e) => setCharges(charges.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} /></div>
        <div><label>البيان</label><input value={c.description} onChange={(e) => setCharges(charges.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} /></div>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" style={{ width: 24, minHeight: 24 }} checked={c.capitalize} onChange={(e) => setCharges(charges.map((x, j) => j === i ? { ...x, capitalize: e.target.checked } : x))} />إضافة إلى كلفة المخزون</label>
        <button type="button" className="danger" onClick={() => setCharges(charges.filter((_, j) => j !== i))}>حذف</button></div>))}
      <button type="button" onClick={() => setCharges([...charges, { kind: "TRANSPORT", description: "", amount: "", capitalize: policy === "INCLUDE" }])}>+ تكلفة إضافية</button>
      <MsgBox msg={msg} /><button className="primary" disabled={busy}>حفظ كمسودة</button>
    </form></>);
}
