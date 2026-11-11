"use client";
import { useState } from "react";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, StatusBadge, useAction, useLoad, ReverseBox } from "@/components/ui";

interface Cust { id: string; name: string } interface Cash { id: string; name: string; currency: string; kind: string }
interface Ref { id: string; docNo: string; docDate: string; customerName: string; cashAccount: string; currency: string; amount: string; reason: string; status: string }
export default function Refunds() {
  const me = useMe(); const list = useLoad<Ref[]>("/api/customer-refunds", []); const custs = useLoad<Cust[]>("/api/contacts?kind=CUSTOMER", []).data; const cash = useLoad<Cash[]>("/api/cash-accounts", []).data;
  const { msg, busy, run } = useAction(() => { void list.reload(); });
  const [cid, setCid] = useState(""); const [rid, setRid] = useState(() => `refund-${crypto.randomUUID()}`);
  const st = useLoad<{ unappliedCredit?: string } | null>(cid ? `/api/customers/${cid}/statement` : null, null).data;
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const r = await run(() => api("/api/customer-refunds", { method: "POST", body: { requestId: rid, customerId: cid, docDate: String(f.get("date")), cashAccountId: String(f.get("cash")), amount: String(f.get("amount")), reason: String(f.get("reason")) } }), "تم ردّ المبلغ للعميل");
    if (r !== undefined) { setRid(`refund-${crypto.randomUUID()}`); (e.target as HTMLFormElement).reset?.(); }
  }
  return (<>
    <h1>ردّ نقد للعميل من رصيده الدائن</h1>
    <p>عملية مستقلة تُخرج نقداً حقيقياً من الصندوق وتُنقص رصيد العميل الدائن؛ لا تغيّر تاريخ أي سند. لا يُرَدّ أكثر من الرصيد الدائن للعميل بعملة الصندوق المختار.</p>
    {can(me, "voucher:create") && can(me, "voucher:approve") && <form className="card" onSubmit={save} style={{ display: "grid", gap: 12 }}><div className="row">
      <div><label htmlFor="c">العميل</label><select id="c" value={cid} onChange={(e) => setCid(e.target.value)} required><option value="">اختر…</option>{custs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <div><label htmlFor="d">التاريخ</label><input id="d" name="date" type="date" defaultValue={today()} /></div>
      <div><label htmlFor="k">الصندوق (يحدد العملة)</label><select id="k" name="cash" required>{cash.filter((c) => c.kind !== "PARTNER_CUSTODY").map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}</select></div>
      <div><label htmlFor="a">المبلغ</label><input id="a" name="amount" inputMode="decimal" dir="ltr" required /></div>
      <div><label htmlFor="r">السبب</label><input id="r" name="reason" required minLength={3} /></div></div>
      {st?.unappliedCredit !== undefined && <small>إجمالي الرصيد الدائن للعميل (بالدينار): <span className="num">{money(st.unappliedCredit)}</span></small>}
      <MsgBox msg={msg} /><button className="primary" disabled={busy || !cid}>تسجيل الردّ</button></form>}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>العميل</th><th>الصندوق</th><th>المبلغ</th><th>السبب</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{list.data.map((r) => <tr key={r.id}><td><span className="num">{r.docNo}</span></td><td><span className="num">{r.docDate}</span></td><td>{r.customerName}</td><td>{r.cashAccount}</td><td><span className="num">{money(r.amount)} {r.currency}</span></td><td>{r.reason}</td><td><StatusBadge s={r.status} /></td>
        <td>{r.status === "POSTED" && can(me, "voucher:cancel") && <ReverseBox label="حذف" busy={busy} onReverse={(reason) => run(() => api(`/api/customer-refunds/${r.id}/reverse`, { method: "POST", body: { reason } }), "تم العكس")} />}</td></tr>)}
        {list.data.length === 0 && <tr><td colSpan={8}>لا توجد عمليات ردّ</td></tr>}</tbody></table></div></>);
}
