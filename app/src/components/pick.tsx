"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "@/lib/client";
import { can, useMe } from "@/components/me";

export interface PickOpt { id: string; label: string }
type Kind = "customer" | "supplier" | "product" | "category";
const META: Record<Kind, { perm: string; noun: string }> = {
  customer: { perm: "contacts:create", noun: "عميل" }, supplier: { perm: "contacts:create", noun: "مورد" },
  product: { perm: "products:create", noun: "مادة" }, category: { perm: "expense:create", noun: "تصنيف" },
};
const autoCode = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}`;
const norm = (s: string) => s.normalize("NFKD").replace(/[ً-ٰٟ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * ONE field for search + choose + create (Odoo-style): type to filter; if the name does not exist the list ends with «إنشاء «الاسم»». Choosing it opens a small dialog
 * pre-filled with what was typed; saving creates the record, selects it and returns to the same form (nothing else on the page is touched). Nothing is created by typing or by leaving the field.
 * Similar names only warn (two different people may share a name); identity is the internal id. Keyboard: ↑ ↓ Enter Esc. Works offline for choosing; creating needs a connection.
 */
export function PickOrCreate({ kind, options, value, onChange, name, id, required, onCreated, defaultValue }: {
  kind: Kind; options: PickOpt[]; value?: string; onChange?: (id: string, created?: PickOpt) => void; name?: string; id?: string; required?: boolean; filterText?: boolean; onCreated?: (o: PickOpt) => void; defaultValue?: string;
}) {
  const me = useMe(); const m = META[kind]; const uid = useId(); const listId = `${uid}-list`;
  const [extra, setExtra] = useState<PickOpt[]>([]); const [inner, setInner] = useState(defaultValue ?? "");
  const cur = value ?? inner; const all = useMemo(() => [...options, ...extra.filter((e) => !options.some((o) => o.id === e.id))], [options, extra]);
  const selected = all.find((o) => o.id === cur); const [text, setText] = useState(selected?.label ?? ""); const [open, setOpen] = useState(false); const [hi, setHi] = useState(0); const [dlg, setDlg] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { setText(all.find((o) => o.id === cur)?.label ?? ""); }, [cur, all]);                // follow external value changes (edit page, programmatic selection)
  useEffect(() => { input.current?.setCustomValidity(required && !cur ? "اختر من القائمة أو أنشئ جديداً" : ""); }, [cur, required]);
  const q = norm(text); const typing = !!q && q !== norm(selected?.label ?? "");
  const matches = useMemo(() => (typing ? all.filter((o) => norm(o.label).includes(q)) : all).slice(0, 50), [all, q, typing]);
  const exact = all.some((o) => norm(o.label) === q);
  const canCreate = can(me, m.perm) && q.length >= 2 && !exact; const rows = [...matches.map((o) => ({ opt: o as PickOpt | null })), ...(canCreate ? [{ opt: null }] : [])];
  const choose = (o: PickOpt) => { setInner(o.id); setText(o.label); setOpen(false); onChange?.(o.id); };
  const clear = () => { setInner(""); onChange?.(""); };
  function key(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && open && rows[hi]) { e.preventDefault(); const r = rows[hi]!; if (r.opt) choose(r.opt); else { setOpen(false); setDlg(true); } }
    else if (e.key === "Escape") { setOpen(false); setText(selected?.label ?? ""); }
  }
  return (<div className="pick" style={{ position: "relative" }}>
    <input ref={input} id={id} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-label={`${m.noun}: اكتب للبحث`} autoComplete="off" value={text} placeholder={`ابحث عن ${m.noun}…`}
      onChange={(e) => { setText(e.target.value); setOpen(true); setHi(0); if (cur) clear(); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => { setOpen(false); setText(all.find((o) => o.id === cur)?.label ?? text); }, 150)} onKeyDown={key} />
    {name && <input type="hidden" name={name} value={cur} />}
    {open && rows.length > 0 && <ul id={listId} role="listbox" className="card" style={{ position: "absolute", insetInline: 0, zIndex: 20, margin: "2px 0 0", padding: 4, maxHeight: 260, overflowY: "auto", listStyle: "none" }}>
      {rows.map((r, i) => <li key={r.opt?.id ?? "new"} role="option" aria-selected={i === hi} style={{ padding: "8px 10px", cursor: "pointer", background: i === hi ? "var(--accent-soft, #e8f0fe)" : undefined, fontWeight: r.opt ? undefined : 700 }}
        onMouseDown={(e) => { e.preventDefault(); if (r.opt) choose(r.opt); else { setOpen(false); setDlg(true); } }} onMouseEnter={() => setHi(i)}>{r.opt ? r.opt.label : `＋ إنشاء «${text.trim()}»`}</li>)}</ul>}
    {open && rows.length === 0 && typing && <div className="card" style={{ position: "absolute", insetInline: 0, zIndex: 20, padding: 8 }}>لا توجد نتائج{can(me, m.perm) ? "" : " (لا تملك صلاحية الإنشاء)"}</div>}
    {dlg && <CreateDialog kind={kind} initialName={text.trim()} similar={all.filter((o) => norm(o.label).includes(norm(text)) || norm(text).includes(norm(o.label))).slice(0, 4)}
      onClose={() => { setDlg(false); input.current?.focus(); }} onCreated={(o) => { setExtra((x) => [...x, o]); choose(o); onCreated?.(o); onChange?.(o.id, o); setDlg(false); }} />}
  </div>);
}

function CreateDialog({ kind, initialName, similar, onClose, onCreated }: { kind: Kind; initialName: string; similar: PickOpt[]; onClose: () => void; onCreated: (o: PickOpt) => void }) {
  const m = META[kind]; const [nm, setNm] = useState(initialName); const [ph, setPh] = useState(""); const [more, setMore] = useState(false); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const [f, setF] = useState<Record<string, string>>({ uom: "قطعة", dec: "0", nat: "VARIABLE", scope: "GENERAL", terms: "0" }); const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const first = useRef<HTMLInputElement>(null); useEffect(() => { first.current?.focus(); first.current?.select(); }, []);
  async function save() {
    setErr(""); if (nm.trim().length < 2) { setErr("الاسم قصير جداً"); return; } if (!navigator.onLine) { setErr("الإنشاء السريع يحتاج اتصالاً بالإنترنت"); return; }
    setBusy(true);
    try {
      let r: { id: string };
      if (kind === "customer" || kind === "supplier") r = await api<{ id: string }>("/api/contacts", { method: "POST", body: { kind: kind === "customer" ? "CUSTOMER" : "SUPPLIER", code: autoCode(kind === "customer" ? "C" : "S"), name: nm.trim(), phones: ph.trim() ? [ph.trim()] : [], address: f.address?.trim() || null, paymentTermsDays: Number(f.terms || 0) } });
      else if (kind === "product") r = await api<{ id: string }>("/api/products", { method: "POST", body: { code: f.code?.trim() || autoCode("P"), name: nm.trim(), baseUom: f.uom || "قطعة", qtyDecimals: Number(f.dec || 0), defaultSalePrice: f.sp || null, defaultPurchasePrice: f.pp || null, uoms: [] } });
      else r = await api<{ id: string }>("/api/expense-categories", { method: "POST", body: { name: nm.trim(), nature: f.nat, scope: f.scope, accountCode: "6900" } });
      onCreated({ id: r.id, label: kind === "product" ? `${f.code?.trim() ?? ""} ${nm.trim()}`.trim() : nm.trim() });
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  return (<div role="dialog" aria-modal="true" aria-label={`إضافة ${m.noun} جديد`} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 50, display: "grid", placeItems: "center", padding: 12 }}
    onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON" && (e.target as HTMLElement).tagName !== "TEXTAREA") { e.preventDefault(); void save(); } }}>
    <div className="card" style={{ width: "min(460px, 100%)", maxHeight: "90vh", overflowY: "auto", display: "grid", gap: 10 }}>
      <h2 style={{ margin: 0 }}>إضافة {m.noun} جديد</h2>
      <div><label htmlFor="pc-nm">الاسم</label><input id="pc-nm" ref={first} value={nm} onChange={(e) => setNm(e.target.value)} /></div>
      {similar.length > 0 && <div className="msg" role="status">يوجد بالفعل: {similar.map((s) => s.label).join("، ")} — سيُنشأ سجل منفصل بهوية داخلية مستقلة إن تابعت.</div>}
      {(kind === "customer" || kind === "supplier") && <div><label htmlFor="pc-ph">الهاتف</label><input id="pc-ph" dir="ltr" inputMode="tel" value={ph} onChange={(e) => setPh(e.target.value)} /></div>}
      {kind === "product" && <><div><label htmlFor="pc-uom">الوحدة الأساسية</label><input id="pc-uom" value={f.uom} onChange={(e) => set("uom", e.target.value)} /></div></>}
      {kind === "category" && <div className="row"><div><label htmlFor="pc-nat">الطبيعة</label><select id="pc-nat" value={f.nat} onChange={(e) => set("nat", e.target.value)}><option value="VARIABLE">متغير</option><option value="FIXED">ثابت</option></select></div>
        <div><label htmlFor="pc-sc">النطاق</label><select id="pc-sc" value={f.scope} onChange={(e) => set("scope", e.target.value)}><option value="GENERAL">عام</option><option value="DIRECT">مباشر</option></select></div></div>}
      {kind !== "category" && <button type="button" onClick={() => setMore(!more)} aria-expanded={more}>{more ? "إخفاء" : "تفاصيل إضافية"}</button>}
      {more && (kind === "customer" || kind === "supplier") && <><div><label htmlFor="pc-ad">العنوان</label><input id="pc-ad" value={f.address ?? ""} onChange={(e) => set("address", e.target.value)} /></div><div><label htmlFor="pc-tm">أيام السداد</label><input id="pc-tm" type="number" min={0} max={365} dir="ltr" value={f.terms} onChange={(e) => set("terms", e.target.value)} /></div></>}
      {more && kind === "product" && <><div><label htmlFor="pc-cd">الكود (اختياري)</label><input id="pc-cd" dir="ltr" value={f.code ?? ""} onChange={(e) => set("code", e.target.value)} /></div><div><label htmlFor="pc-dc">منازل الكمية</label><input id="pc-dc" type="number" min={0} max={6} dir="ltr" value={f.dec} onChange={(e) => set("dec", e.target.value)} /></div>
        <div><label htmlFor="pc-sp">سعر البيع الافتراضي (IQD)</label><input id="pc-sp" dir="ltr" inputMode="decimal" value={f.sp ?? ""} onChange={(e) => set("sp", e.target.value)} /></div><div><label htmlFor="pc-pp">سعر الشراء الافتراضي (IQD)</label><input id="pc-pp" dir="ltr" inputMode="decimal" value={f.pp ?? ""} onChange={(e) => set("pp", e.target.value)} /></div></>}
      {err && <div className="msg err" role="alert">{err}</div>}
      <div style={{ display: "flex", gap: 8 }}><button type="button" className="primary" disabled={busy} onClick={() => void save()}>حفظ واختيار</button><button type="button" onClick={onClose}>إلغاء</button></div>
    </div></div>);
}
