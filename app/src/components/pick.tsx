"use client";
import { useRef, useState } from "react";
import { api } from "@/lib/client";
import { can, useMe } from "@/components/me";

export interface PickOpt { id: string; label: string }
type Kind = "customer" | "supplier" | "product" | "category";
const META: Record<Kind, { perm: string; noun: string }> = {
  customer: { perm: "contacts:create", noun: "عميل" }, supplier: { perm: "contacts:create", noun: "مورد" },
  product: { perm: "products:create", noun: "مادة" }, category: { perm: "expense:create", noun: "تصنيف" },
};
const autoCode = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}`;

/** A normal <select> (so forms keep working) plus "+ جديد": create the missing customer/supplier/product/category right here and have it selected. Online only. */
export function PickOrCreate({ kind, options, value, onChange, name, id, required, filterText, onCreated }: {
  kind: Kind; options: PickOpt[]; value?: string; onChange?: (id: string, created?: PickOpt) => void; name?: string; id?: string; required?: boolean; filterText?: boolean; onCreated?: (o: PickOpt) => void;
}) {
  const me = useMe(); const m = META[kind];
  const [extra, setExtra] = useState<PickOpt[]>([]); const [inner, setInner] = useState(""); const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [q, setQ] = useState("");
  const list = [...options, ...extra.filter((e) => !options.some((o) => o.id === e.id))];
  const shown = q ? list.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()) || o.id === (value ?? inner)) : list;
  const cur = value ?? inner;
  const field = (n: string) => (box.current?.querySelector(`[name="${n}"]`) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
  async function create() {
    setErr("");
    if (!navigator.onLine) { setErr("الإنشاء السريع يحتاج اتصالاً بالإنترنت"); return; }
    const f = { get: field }; const nm = field("nm").trim(); if (nm.length < 2) { setErr("الاسم قصير جداً"); return; } setBusy(true);
    try {
      let r: { id: string }; 
      if (kind === "customer" || kind === "supplier") r = await api<{ id: string }>("/api/contacts", { method: "POST", body: { kind: kind === "customer" ? "CUSTOMER" : "SUPPLIER", code: autoCode(kind === "customer" ? "C" : "S"), name: nm, phones: String(f.get("ph") ?? "").trim() ? [String(f.get("ph")).trim()] : [], paymentTermsDays: Number(f.get("terms") || 0) } });
      else if (kind === "product") r = await api<{ id: string }>("/api/products", { method: "POST", body: { code: String(f.get("code") || "") || autoCode("P"), name: nm, baseUom: String(f.get("uom") || "قطعة"), qtyDecimals: Number(f.get("dec") || 0), defaultSalePrice: String(f.get("sp") || "") || null, defaultPurchasePrice: String(f.get("pp") || "") || null, uoms: [] } });
      else r = await api<{ id: string }>("/api/expense-categories", { method: "POST", body: { name: nm, nature: String(f.get("nat")), scope: String(f.get("scope")), accountCode: "6900" } });
      const opt = { id: r.id, label: kind === "product" ? `${String(f.get("code") || "")} ${nm}`.trim() : nm };
      setExtra((x) => [...x, opt]); setInner(opt.id); setOpen(false); setQ(""); onChange?.(opt.id, opt); onCreated?.(opt);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  return (<div className="pick">
    <div style={{ display: "flex", gap: 6 }}>
      {filterText && <input aria-label="بحث" placeholder="بحث…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 90, flex: "0 0 auto" }} />}
      <select style={{ flex: "1 1 140px", minWidth: 0 }} id={id} name={name} required={required} value={cur} onChange={(e) => { setInner(e.target.value); onChange?.(e.target.value); }}>
        <option value="">اختر…</option>{shown.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
      {can(me, m.perm) && <button type="button" onClick={() => { setOpen(!open); setErr(""); }} aria-expanded={open} title={`إضافة ${m.noun} جديد`}>＋ جديد</button>}
    </div>
    {open && <div ref={box} className="card row" role="group" aria-label={`إضافة ${m.noun} جديد`} style={{ marginTop: 6 }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void create(); } }}>
      <div><label>اسم {m.noun} الجديد</label><input name="nm" required minLength={2} autoFocus defaultValue={q} /></div>
      {(kind === "customer" || kind === "supplier") && <><div><label>الهاتف</label><input name="ph" dir="ltr" /></div><div><label>أيام السداد</label><input name="terms" type="number" min={0} max={365} defaultValue={0} dir="ltr" /></div></>}
      {kind === "product" && <><div><label>الكود (اختياري)</label><input name="code" dir="ltr" /></div><div><label>الوحدة الأساسية</label><input name="uom" defaultValue="قطعة" /></div><div><label>منازل الكمية</label><input name="dec" type="number" min={0} max={6} defaultValue={0} dir="ltr" /></div><div><label>سعر البيع</label><input name="sp" inputMode="decimal" dir="ltr" /></div><div><label>سعر الشراء</label><input name="pp" inputMode="decimal" dir="ltr" /></div></>}
      {kind === "category" && <><div><label>الطبيعة</label><select name="nat"><option value="VARIABLE">متغير</option><option value="FIXED">ثابت</option></select></div><div><label>النطاق</label><select name="scope"><option value="GENERAL">عام</option><option value="DIRECT">مباشر</option></select></div></>}
      <button type="button" className="primary" disabled={busy} onClick={() => void create()}>حفظ واختيار</button><button type="button" onClick={() => setOpen(false)}>إلغاء</button>
      {err && <div className="msg err" role="alert">{err}</div>}</div>}
  </div>);
}
