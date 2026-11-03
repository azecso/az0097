"use client";
import { api, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, StatusBadge, useAction, useLoad } from "@/components/ui";

interface C { id: string; draftRef: string; docNo: string | null; docDate: string; location: string; reason: string; status: string }
interface Prod { id: string; code: string; name: string; baseUom: string } interface Loc { id: string; name: string }
export default function Counts() {
  const me = useMe(); const list = useLoad<C[]>("/api/inventory-counts", []); const prods = useLoad<Prod[]>("/api/products", []).data, locs = useLoad<Loc[]>("/api/locations", []).data;
  const { msg, busy, run } = useAction(list.reload);
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await run(() => api("/api/inventory-counts", { method: "POST", body: { docDate: String(f.get("date")), locationId: String(f.get("loc")), reason: String(f.get("reason")), lines: [{ productId: String(f.get("prod")), countedQtyBase: String(f.get("qty")), unitCostBase: String(f.get("cost") ?? "") || null }] } }), "حُفظت مسودة الجرد");
  }
  return (<>
    <h1>الجرد والتعديلات</h1>
    <p>النقص يُخصم من أقدم الطبقات ويُسجَّل كخسارة جرد. الزيادة تتطلب تكلفة وحدة صريحة. الاعتماد للمالك فقط.</p>
    {can(me, "inventory_count:create") && <form className="card row" onSubmit={create}>
      <div><label htmlFor="d">التاريخ</label><input id="d" name="date" type="date" defaultValue={today()} /></div>
      <div><label htmlFor="l">الموقع</label><select id="l" name="loc">{locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
      <div><label htmlFor="p">المادة</label><select id="p" name="prod" required><option value="">اختر…</option>{prods.map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</select></div>
      <div><label htmlFor="q">الكمية الفعلية (وحدة أساسية)</label><input id="q" name="qty" required inputMode="decimal" dir="ltr" /></div>
      <div><label htmlFor="c">تكلفة الوحدة (للزيادة فقط)</label><input id="c" name="cost" inputMode="decimal" dir="ltr" /></div>
      <div><label htmlFor="r">السبب</label><input id="r" name="reason" required minLength={3} /></div>
      <button className="primary" disabled={busy}>حفظ كمسودة</button></form>}
    <MsgBox msg={msg} />
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>الموقع</th><th>السبب</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{list.data.map((c) => <tr key={c.id}><td><span className="num">{c.docNo ?? c.draftRef}</span></td><td><span className="num">{c.docDate}</span></td><td>{c.location}</td><td>{c.reason}</td><td><StatusBadge s={c.status} /></td>
        <td>{c.status === "DRAFT" && <>{can(me, "inventory_count:approve") && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/inventory-counts/${c.id}/post`, { method: "POST" }), "تم اعتماد الجرد")}>اعتماد</button>}
          <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/inventory-counts/${c.id}`, { method: "DELETE" }), "حُذفت المسودة")}>حذف</button></>}</td></tr>)}
        {list.data.length === 0 && <tr><td colSpan={6}>لا توجد عمليات جرد</td></tr>}</tbody></table></div></>);
}
