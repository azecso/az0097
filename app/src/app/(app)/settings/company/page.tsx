"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { Attach } from "@/components/attach";

interface Co { name: string; nameEn: string | null; address: string | null; phones: string[] | null; baseCurrency: string; allowNegativeStock: boolean; landedCostPolicy: "EXCLUDE" | "INCLUDE"; version: number }
export default function Company() {
  const me = useMe(); const [c, setC] = useState<Co | null>(null); const [msg, setMsg] = useState<{ t: "ok" | "err"; m: string } | null>(null);
  const load = () => api<Co>("/api/company").then(setC);
  useEffect(() => { void load(); }, []);
  if (!c) return <p>جارٍ التحميل…</p>;
  const editable = can(me, "company:edit_draft");
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setMsg(null);
    try {
      await api("/api/company", { method: "PATCH", body: { name: String(f.get("name")), nameEn: String(f.get("nameEn") ?? "") || null, address: String(f.get("address") ?? "") || null,
        phones: String(f.get("phones") ?? "").split(/[,،\s]+/).filter(Boolean), allowNegativeStock: f.get("neg") === "on", landedCostPolicy: String(f.get("lc")), version: c!.version } });
      setMsg({ t: "ok", m: "تم الحفظ" }); await load();
    } catch (x) { setMsg({ t: "err", m: (x as Error).message }); }
  }
  return (<>
    <h1>بيانات الشركة</h1>
    <form className="card" onSubmit={save} style={{ display: "grid", gap: 12 }}>
      <div><label htmlFor="n">الاسم</label><input id="n" name="name" defaultValue={c.name} required disabled={!editable} /></div>
      <div><label htmlFor="e">الاسم بالإنجليزية</label><input id="e" name="nameEn" defaultValue={c.nameEn ?? ""} dir="ltr" disabled={!editable} /></div>
      <div><label htmlFor="a">العنوان</label><input id="a" name="address" defaultValue={c.address ?? ""} disabled={!editable} /></div>
      <div><label htmlFor="p">الهواتف (مفصولة بفاصلة)</label><input id="p" name="phones" defaultValue={(c.phones ?? []).join(", ")} dir="ltr" disabled={!editable} /></div>
      <div><label>عملة الأساس</label><input value={c.baseCurrency} disabled dir="ltr" /></div>
      <div><label htmlFor="lc">السياسة الافتراضية للنقل والتكاليف الإضافية (يمكن تغييرها لكل بند في فاتورة الشراء)</label><select id="lc" name="lc" defaultValue={c.landedCostPolicy} disabled={!editable}>
        <option value="EXCLUDE">افتراضياً: النقل والتكاليف الإضافية مصروف (سعر المادة فقط في المخزون)</option><option value="INCLUDE">افتراضياً: تُضاف التكاليف الإضافية إلى كلفة المخزون</option></select></div>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" name="neg" defaultChecked={c.allowNegativeStock} disabled={!editable} style={{ width: 24, minHeight: 24 }} />السماح بالمخزون السالب (غير مستحسن)</label>
      {msg && <div className={`msg ${msg.t}`} role="status">{msg.m}</div>}
      {editable ? <button className="primary">حفظ</button> : <span className="badge">للمالك فقط</span>}
    </form>
    {editable && <><Attach entityType="company_logo" entityId={me.companyId} label="شعار الشركة (يظهر على المستندات المطبوعة)" accept="image/png,image/jpeg,image/webp" single />
      <Attach entityType="company_signature" entityId={me.companyId} label="التوقيع (صورة)" accept="image/png,image/jpeg,image/webp" single /></>}</>);
}
