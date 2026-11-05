"use client";
import { useState } from "react";
import { api, money } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, StatusBadge, useAction, useLoad , ReverseBox, PrintLink } from "@/components/ui";

interface R { id: string; draftRef: string; docNo: string | null; docDate: string; invoiceNo: string; settlement: string; status: string; valueBase: string }
export default function SalesReturns() {
  const me = useMe(); const { data, reload, err } = useLoad<R[]>("/api/sales-returns", []); const { msg, busy, run } = useAction(reload); const [reason, setReason] = useState("");
  return (<><h1>مرتجعات المبيعات</h1><p>تُنشأ المرتجعات من صفحة الفاتورة. المخزون يعود لنفس الطبقات بتكلفة البيع الأصلية.</p>
    <MsgBox msg={msg} />{err && <div className="msg err">{err}</div>}
    <div className="card cards-as-list"><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>الفاتورة</th><th>القيمة (IQD)</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{data.map((r) => <tr key={r.id}><td><span className="num">{r.docNo ?? r.draftRef}</span></td><td><span className="num">{r.docDate}</span></td><td><span className="num">{r.invoiceNo}</span></td><td><span className="num">{money(r.valueBase)}</span></td><td><StatusBadge s={r.status} /></td>
        <td><PrintLink path={`/print/doc/sales-return/${r.id}`} />{r.status === "DRAFT" && can(me, "sales:approve") && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/sales-returns/${r.id}/post`, { method: "POST" }), "تم الترحيل")}>ترحيل</button>}
          {r.status === "DRAFT" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/sales-returns/${r.id}`, { method: "DELETE" }), "حُذفت المسودة")}>حذف</button>}
          {r.status === "POSTED" && can(me, "sales:cancel") && <ReverseBox busy={busy} onReverse={(reason) => run(() => api(`/api/sales-returns/${r.id}/reverse`, { method: "POST", body: { reason } }), "تم العكس")} />}</td></tr>)}
        {data.length === 0 && <tr><td colSpan={6}>لا توجد مرتجعات</td></tr>}</tbody></table></div></>);
}
