"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, StatusBadge, useAction, useLoad , ReverseBox } from "@/components/ui";

interface D { id: string; draftRef: string; docNo: string | null; docDate: string; invoiceNo: string; customerName: string; status: string; auto: boolean }
export default function Deliveries() {
  const me = useMe(); const { data, reload, err } = useLoad<D[]>("/api/delivery-notes", []); const { msg, busy, run } = useAction(reload); const [reason, setReason] = useState("");
  const [showDel, setShowDel] = useState(false);
  return (<><h1>سندات التسليم</h1><p>يُنشأ سند التسليم تلقائياً مع فاتورة «التسليم مع الفاتورة»، أو يدوياً من صفحة الفاتورة عند «تسليم منفصل». ترحيل السند هو لحظة خروج البضاعة (FIFO) وتسجيل تكلفتها.</p>
    <MsgBox msg={msg} />{err && <div className="msg err">{err}</div>}
    <label style={{ display: "inline-flex", gap: 6, alignItems: "center", margin: "4px 0" }}><input type="checkbox" checked={showDel} onChange={(e) => setShowDel(e.target.checked)} />إظهار المحذوفة</label>
    <div className="card cards-as-list"><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>الفاتورة</th><th>العميل</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{data.filter((x) => showDel || x.status !== "REVERSED").map((x) => <tr key={x.id}><td><span className="num">{x.docNo ?? x.draftRef}</span> {x.auto && <span className="badge">تلقائي</span>}</td><td><span className="num">{x.docDate}</span></td><td><span className="num">{x.invoiceNo}</span></td><td>{x.customerName}</td><td><StatusBadge s={x.status} /></td>
        <td><a href={`/print/delivery/${x.id}`} target="_blank" rel="noreferrer"><button>طباعة</button></a>{x.status === "DRAFT" && can(me, "sales:approve") && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/delivery-notes/${x.id}/post`, { method: "POST" }), "تم التسليم")}>ترحيل</button>}
          {x.status === "DRAFT" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/delivery-notes/${x.id}`, { method: "DELETE" }), "حُذفت المسودة")}>حذف</button>}
          {x.status === "POSTED" && !x.auto && can(me, "sales:cancel") && <ReverseBox label="حذف" busy={busy} onReverse={(reason) => run(() => api(`/api/delivery-notes/${x.id}/reverse`, { method: "POST", body: { reason } }), "تم العكس")} />}</td></tr>)}
        {data.length === 0 && <tr><td colSpan={6}>لا توجد سندات</td></tr>}</tbody></table></div></>);
}
