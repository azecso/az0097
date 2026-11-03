"use client";
import { api, money } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, useAction, useLoad } from "@/components/ui";

interface P { id: string; code: string; name: string; baseUom: string; qtyDecimals: number; uoms: { uom: string; factorToBase: string }[]; defaultPurchasePrice: string | null; isArchived: boolean; version: number }
export default function Products() {
  const me = useMe(); const { data, err, reload } = useLoad<P[]>("/api/products?archived=1", []); const { msg, busy, run } = useAction(reload);
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget), form = e.currentTarget;
    const uoms = String(f.get("uoms") ?? "").split(/[,،\n]+/).map((x) => x.trim()).filter(Boolean).map((x) => { const [uom, factor] = x.split("="); return { uom: (uom ?? "").trim(), factorToBase: (factor ?? "").trim() }; });
    const r = await run(() => api("/api/products", { method: "POST", body: { code: String(f.get("code")), name: String(f.get("name")), baseUom: String(f.get("baseUom")), qtyDecimals: Number(f.get("dec") ?? 0), uoms,
      defaultPurchasePrice: String(f.get("price") ?? "") || null } }), "تمت إضافة المادة");
    if (r) form.reset();
  }
  return (<>
    <h1>المواد</h1>
    {can(me, "products:create") && <form className="card" onSubmit={create} style={{ display: "grid", gap: 12 }}>
      <div className="row">
        <div><label htmlFor="c">الكود (فريد)</label><input id="c" name="code" required dir="ltr" /></div>
        <div><label htmlFor="n">الاسم</label><input id="n" name="name" required /></div>
        <div><label htmlFor="b">الوحدة الأساسية</label><input id="b" name="baseUom" required defaultValue="قطعة" /></div>
        <div><label htmlFor="d">منازل الكمية (0 للقطع)</label><input id="d" name="dec" type="number" min={0} max={6} defaultValue={0} /></div>
      </div>
      <div className="row">
        <div><label htmlFor="u">وحدات إضافية (مثال: كارتون=12, صندوق=48) — لكل مادة تحويلها الخاص</label><input id="u" name="uoms" dir="ltr" placeholder="كارتون=12" /></div>
        <div><label htmlFor="p">سعر شراء افتراضي</label><input id="p" name="price" inputMode="decimal" dir="ltr" /></div>
        <button className="primary" disabled={busy}>إضافة</button>
      </div></form>}
    <MsgBox msg={msg} />{err && <div className="msg err">{err}</div>}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الكود</th><th>الاسم</th><th>الوحدة</th><th>الوحدات الإضافية</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{data.map((p) => <tr key={p.id}><td><span className="num">{p.code}</span></td><td>{p.name}</td><td>{p.baseUom}</td>
        <td>{p.uoms.map((u) => `${u.uom}=${money(u.factorToBase)}`).join("، ") || "—"}</td><td>{p.isArchived ? "مؤرشف" : "نشط"}</td>
        <td>{can(me, "products:edit_draft") && <button disabled={busy} onClick={() => run(() => api(`/api/products/${p.id}`, { method: "PATCH", body: { isArchived: !p.isArchived, version: p.version } }), "تم التحديث")}>{p.isArchived ? "استعادة" : "أرشفة"}</button>}</td></tr>)}
        {data.length === 0 && <tr><td colSpan={6}>لا توجد مواد بعد</td></tr>}</tbody></table></div></>);
}
