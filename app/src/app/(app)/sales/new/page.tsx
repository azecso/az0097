"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api, money, today } from "@/lib/client";
import { createDraft, useRefList } from "@/lib/offline/use";
import { MsgBox, useAction, useLoad } from "@/components/ui";
import { PickOrCreate } from "@/components/pick";

interface Prod { id: string; code: string; name: string; baseUom: string; uoms: { uom: string }[]; defaultSalePrice: string | null }
interface Contact { id: string; name: string } interface Cash { id: string; name: string; currency: string; kind: string } interface Loc { id: string; name: string }
interface Line { productId: string; uom: string; qty: string; unitPrice: string; lineDiscount: string; locationId: string }
const blank: Line = { productId: "", uom: "", qty: "", unitPrice: "", lineDiscount: "", locationId: "" };
function Inner() {
  const router = useRouter(); const { msg, busy, run, setMsg } = useAction();
  const [newProds, setNewProds] = useState<Prod[]>([]); const prodsLoaded = useRefList<Prod>("products", "/api/products").data, cust = useRefList<Contact & { kind?: string }>("contacts", "/api/contacts?kind=CUSTOMER", (c) => c.kind !== "SUPPLIER").data, cash = useRefList<Cash>("cashAccounts", "/api/cash-accounts").data, locs = useRefList<Loc>("locations", "/api/locations").data; const prods = [...prodsLoaded, ...newProds];
  const sp = useSearchParams(); const editId = sp.get("edit"); const srcId = editId ?? sp.get("copy"); const ex = useLoad<any>(srcId ? `/api/sales-invoices/${srcId}` : null, null).data; const ed = editId ? ex : null;
  const [type, setType] = useState("CREDIT"); const [cur, setCur] = useState("IQD"); const [lines, setLines] = useState<Line[]>([blank]); const [disc, setDisc] = useState("");
  const tr = (v: string | null | undefined) => (v && v.includes(".") ? v.replace(/\.?0+$/, "") : v ?? "");
  useEffect(() => { if (!ex || (editId && ex.status !== "DRAFT" && ex.status !== "POSTED")) return; setType(ex.saleType); setCur(ex.currency); setDisc(tr(ex.discount) === "0" ? "" : tr(ex.discount));
    setLines(ex.lines.map((l: any) => ({ productId: l.productId, uom: l.uom, qty: tr(l.qty), unitPrice: tr(l.unitPrice), lineDiscount: tr(l.lineDiscount) === "0" ? "" : tr(l.lineDiscount), locationId: l.locationId ?? "" }))); }, [ex]);
  const upd = (i: number, k: keyof Line, v: string) => setLines((ls) => ls.map((l, j) => j !== i ? l : { ...l, [k]: v, ...(k === "productId" ? { uom: prods.find((p) => p.id === v)?.baseUom ?? "", unitPrice: prods.find((p) => p.id === v)?.defaultSalePrice ?? l.unitPrice } : {}) }));
  const gross = lines.reduce((s, l) => s + Math.max(0, Number(l.qty || 0) * Number(l.unitPrice || 0) - Number(l.lineDiscount || 0)), 0);   // preview only; the server computes exactly with decimals
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const payload = { customerId: String(f.get("customer")), docDate: String(f.get("date")), eventDate: String(f.get("event") ?? "") || null, saleType: type,
      cashAccountId: type === "CASH" ? String(f.get("cash")) : null, dueDate: type === "CREDIT" && f.get("due") ? String(f.get("due")) : null, currency: cur, exchangeRate: cur === "USD" ? String(f.get("rate") || "") || null : null,
      deliveryMode: String(f.get("mode")), discount: disc || "0", terms: String(f.get("terms") ?? "") || null, notes: String(f.get("notes") ?? "") || null,
      lines: lines.map((l) => ({ productId: l.productId, uom: l.uom, qty: l.qty, unitPrice: l.unitPrice, lineDiscount: l.lineDiscount || "0", locationId: l.locationId || null })) };
    if (editId) { if (!ex) return; const posted = ex.status === "POSTED"; const u = await run(() => api<{ id: string }>(posted ? `/api/sales-invoices/${editId}/amend` : `/api/sales-invoices/${editId}`, { method: posted ? "POST" : "PUT", body: { ...payload, version: ex.version } }), "تم حفظ التعديل"); if (u !== undefined) router.push(`/sales/${posted ? u.id : editId}`); return; }
    const r = await run(() => createDraft({ entityType: "sales_invoice", endpoint: "/api/sales-invoices", title: "فاتورة بيع (أوفلاين)", payload }), "تم حفظ المسودة");
    if (r?.mode === "queued") { setMsg({ t: "ok", m: "📴 حُفظت على جهازك مشفّرة وبانتظار المزامنة — ستُرسل تلقائياً عند عودة الاتصال (تابعها من «المزامنة»)." }); setLines([blank]); setDisc(""); } else if (r) router.push(`/sales/${r.id}`);
  }
  return (<>
    <h1>{editId ? "تعديل فاتورة بيع (مسودة)" : sp.get("copy") ? "فاتورة بيع مصحَّحة (نسخة جديدة)" : "فاتورة بيع جديدة"}</h1>{editId && ex && ex.status !== "DRAFT" && ex.status !== "POSTED" && <div className="msg err">هذه الفاتورة محذوفة ولا يمكن تعديلها.</div>}{editId && ex?.status === "POSTED" && <div className="msg">فاتورة مرحّلة: يبقى رقمها <strong className="num">{ex.docNo}</strong> وتُعاد حركة المخزون والقيود تلقائياً. لا يصح التعديل إن كان عليها قبض أو مرتجع.</div>}
    <p>تُحفظ مسودة؛ عند الترحيل يصدر الرقم النهائي، وتُسجَّل المبيعات، وتخرج البضاعة من أقدم الطبقات وتُحتسب تكلفتها (سند تسليم تلقائي).</p>
    <form key={ex?.id ?? "new"} className="card" onSubmit={save} style={{ display: "grid", gap: 12 }}>
      <div className="row">
        <div><label htmlFor="c">العميل</label><PickOrCreate kind="customer" filterText id="c" name="customer" required defaultValue={ex?.customerId} options={cust.map((c) => ({ id: c.id, label: c.name }))} /></div>
        <div><label htmlFor="d">التاريخ</label><input id="d" name="date" type="date" defaultValue={ed?.docDate ?? today()} required /></div>
        <div><label htmlFor="ev">تاريخ البيع الفعلي (إن سُجّلت لاحقاً)</label><input id="ev" name="event" type="date" defaultValue={ed?.eventDate ?? ""} /></div>
      </div>
      <div className="row">
        <div><label htmlFor="t">النوع</label><select id="t" value={type} onChange={(e) => setType(e.target.value)}><option value="CREDIT">آجل</option><option value="CASH">نقدي</option></select></div>
        <div><label htmlFor="cu">العملة</label><select id="cu" value={cur} onChange={(e) => setCur(e.target.value)}><option>IQD</option><option>USD</option></select></div>
        {cur === "USD" && <div><label htmlFor="r">سعر الصرف (فارغ = سعر اليوم)</label><input id="r" name="rate" inputMode="decimal" dir="ltr" defaultValue={ex?.currency === "USD" ? tr(ex.exchangeRate) : ""} /></div>}
        {type === "CASH" ? <div><label htmlFor="ca">يُقبض في (صندوق أو عهدة الشريك)</label><select id="ca" name="cash" defaultValue={ex?.cashAccountId ?? undefined}>{cash.filter((c) => c.currency === cur).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          : <div><label htmlFor="du">الاستحقاق (فارغ = حسب شروط العميل)</label><input id="du" name="due" type="date" defaultValue={ed?.dueDate ?? ""} /></div>}
        <div><label htmlFor="m">التسليم</label><select id="m" name="mode" defaultValue={ex?.deliveryMode ?? "WITH_INVOICE"}><option value="WITH_INVOICE">مع الفاتورة (تلقائي)</option><option value="SEPARATE">بسند تسليم منفصل</option></select></div>
      </div>
      <h2>البنود</h2>
      {lines.map((l, i) => { const p = prods.find((x) => x.id === l.productId); return (
        <div className="row card" key={i}>
          <div><label>المادة</label><PickOrCreate kind="product" filterText options={prods.map((x) => ({ id: x.id, label: `${x.code} — ${x.name}` }))} value={l.productId} onChange={(v) => upd(i, "productId", v)} required onCreated={(o) => { void api<Prod[]>("/api/products").then((all) => { const p = all.find((x) => x.id === o.id); if (p) { setNewProds((x) => [...x, p]); upd(i, "uom", p.baseUom); } }); }} /></div>
          <div><label>الوحدة</label><select value={l.uom} onChange={(e) => upd(i, "uom", e.target.value)}>{p && [p.baseUom, ...p.uoms.map((u) => u.uom)].map((u) => <option key={u}>{u}</option>)}</select></div>
          <div><label>الكمية</label><input value={l.qty} onChange={(e) => upd(i, "qty", e.target.value)} inputMode="decimal" dir="ltr" required /></div>
          <div><label>السعر ({cur})</label><input value={l.unitPrice} onChange={(e) => upd(i, "unitPrice", e.target.value)} inputMode="decimal" dir="ltr" required /></div>
          <div><label>خصم البند</label><input value={l.lineDiscount} onChange={(e) => upd(i, "lineDiscount", e.target.value)} inputMode="decimal" dir="ltr" /></div>
          <div><label>من موقع</label><select value={l.locationId} onChange={(e) => upd(i, "locationId", e.target.value)}><option value="">الرئيسي</option>{locs.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
          {lines.length > 1 && <button type="button" className="danger" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>حذف</button>}
        </div>); })}
      <button type="button" onClick={() => setLines([...lines, blank])}>+ بند</button>
      <div className="row"><div><label htmlFor="ds">خصم على الفاتورة ({cur})</label><input id="ds" value={disc} onChange={(e) => setDisc(e.target.value)} inputMode="decimal" dir="ltr" /></div>
        <div><label>الإجمالي التقريبي</label><strong className="num">{money(String(gross - Number(disc || 0)))} {cur}</strong></div></div>
      <div className="row"><div><label htmlFor="tm">الشروط</label><input id="tm" name="terms" defaultValue={ex?.terms ?? ""} /></div><div><label htmlFor="nt">ملاحظات</label><input id="nt" name="notes" defaultValue={ex?.notes ?? ""} /></div></div>
      <MsgBox msg={msg} /><button className="primary" disabled={busy}>حفظ كمسودة</button>
    </form></>);
}
export default function NewInvoice() { return <Suspense fallback={null}><Inner /></Suspense>; }
