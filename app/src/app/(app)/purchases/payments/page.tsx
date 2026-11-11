"use client";
import { FxRateField } from "@/components/fx-rate-field";
import { useState } from "react";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, StatusBadge, useAction, useLoad , ReverseBox } from "@/components/ui";

interface Pay { id: string; draftRef: string; docNo: string | null; docDate: string; supplierName: string; currency: string; amount: string; status: string; fxDiffBase: string }
interface Aging { id: string; docNo: string; supplier: string; currency: string; outstanding: string; dueDate: string | null; daysOverdue: number }
interface Sup { id: string; name: string } interface Cash { id: string; name: string; currency: string; kind: string }
export default function Payments() {
  const me = useMe(); const list = useLoad<Pay[]>("/api/supplier-payments", []); const aging = useLoad<Aging[]>("/api/reports/payables", []);
  const sup = useLoad<Sup[]>("/api/contacts?kind=SUPPLIER", []).data, cash = useLoad<Cash[]>("/api/cash-accounts", []).data;
  const { msg, busy, run } = useAction(() => { void list.reload(); void aging.reload(); });
  const [alloc, setAlloc] = useState<Record<string, string>>({}); const [reason, setReason] = useState("");
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const cur = cash.find((c) => c.id === String(f.get("cash")))?.currency ?? "IQD";
    const allocations = Object.entries(alloc).filter(([, v]) => v).map(([purchaseId, amount]) => ({ purchaseId, amount }));
    const r = await run(() => api<{ id: string }>("/api/supplier-payments", { method: "POST", body: { supplierId: String(f.get("sup")), docDate: String(f.get("date")), cashAccountId: String(f.get("cash")), currency: cur, exchangeRate: cur === "IQD" ? null : String(f.get("rate") || "") || null, amount: String(f.get("amount")), allocations } }), "حُفظت مسودة السند");
    if (r) setAlloc({});
  }
  const [showDel, setShowDel] = useState(false);
  return (<>
    <h1>سندات الصرف للموردين</h1>
    {can(me, "voucher:create") && <form className="card" onSubmit={create} style={{ display: "grid", gap: 12 }}>
      <div className="row">
        <div><label htmlFor="s">المورد</label><select id="s" name="sup" required><option value="">اختر…</option>{sup.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div><label htmlFor="d">التاريخ</label><input id="d" name="date" type="date" defaultValue={today()} /></div>
        <div><label htmlFor="c">الصندوق (يحدد العملة)</label><select id="c" name="cash" required>{cash.filter((c) => c.kind !== "PARTNER_CUSTODY").map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}</select></div>
        <div><label htmlFor="a">المبلغ</label><input id="a" name="amount" inputMode="decimal" dir="ltr" required /></div>
        <FxRateField />
      </div>
      <p>خصّص الدفعة على فواتير آجلة مستحقة (المتبقي غير المخصص يُسجَّل دفعة مقدمة للمورد). فرق الصرف يُحتسب عند الترحيل.</p>
      <div className="cards-as-list"><table><thead><tr><th>الفاتورة</th><th>المورد</th><th>المستحق</th><th>الاستحقاق</th><th>تخصيص</th></tr></thead>
        <tbody>{aging.data.filter((a) => Number(a.outstanding) > 0).map((a) => <tr key={a.id}><td><span className="num">{a.docNo}</span></td><td>{a.supplier}</td><td><span className="num">{money(a.outstanding)} {a.currency}</span></td>
          <td><span className="num">{a.dueDate ?? "—"}</span>{a.daysOverdue > 0 && <span className="badge"> متأخر {a.daysOverdue} يوم</span>}</td>
          <td><input style={{ maxWidth: 140 }} dir="ltr" inputMode="decimal" value={alloc[a.id] ?? ""} onChange={(e) => setAlloc({ ...alloc, [a.id]: e.target.value })} /></td></tr>)}</tbody></table></div>
      <MsgBox msg={msg} /><button className="primary" disabled={busy}>حفظ كمسودة</button></form>}
    <label style={{ display: "inline-flex", gap: 6, alignItems: "center", margin: "4px 0" }}><input type="checkbox" checked={showDel} onChange={(e) => setShowDel(e.target.checked)} />إظهار المحذوفة</label>
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>المورد</th><th>المبلغ</th><th>فرق الصرف (IQD)</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{list.data.filter((p) => showDel || p.status !== "REVERSED").map((p) => <tr key={p.id}><td><span className="num">{p.docNo ?? p.draftRef}</span></td><td><span className="num">{p.docDate}</span></td><td>{p.supplierName}</td><td><span className="num">{money(p.amount)} {p.currency}</span></td><td><span className="num">{money(p.fxDiffBase)}</span></td><td><StatusBadge s={p.status} /></td>
        <td><a href={`/print/supplier-payment/${p.id}`} target="_blank" rel="noreferrer"><button>طباعة</button></a>{p.status === "DRAFT" && can(me, "voucher:approve") && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/supplier-payments/${p.id}/post`, { method: "POST" }), "تم الترحيل")}>ترحيل</button>}
          {p.status === "DRAFT" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/supplier-payments/${p.id}`, { method: "DELETE" }), "حُذفت المسودة")}>حذف</button>}
          {p.status === "POSTED" && can(me, "voucher:cancel") && <ReverseBox label="حذف" busy={busy} onReverse={(reason) => run(() => api(`/api/supplier-payments/${p.id}/reverse`, { method: "POST", body: { reason } }), "تم العكس")} />}</td></tr>)}
        {list.data.length === 0 && <tr><td colSpan={7}>لا توجد سندات</td></tr>}</tbody></table></div></>);
}
