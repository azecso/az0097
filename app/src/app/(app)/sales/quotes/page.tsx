"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, StatusBadge, useAction, useLoad } from "@/components/ui";

interface Q { id: string; draftRef: string; docNo: string | null; docDate: string; validUntil: string | null; customerName: string; currency: string; total: string; status: string; invoiceId: string | null }
const QS: Record<string, string> = { DRAFT: "مسودة", SENT: "صادر", ACCEPTED: "مقبول", REJECTED: "مرفوض", EXPIRED: "منتهٍ", CONVERTED: "حُوِّل لفاتورة" };
export default function Quotes() {
  const me = useMe(); const router = useRouter(); const { data, reload, err } = useLoad<Q[]>("/api/sales-quotes", []); const { msg, busy, run } = useAction(reload);
  return (<>
    <h1>عروض الأسعار</h1>
    {can(me, "sales:create") && <p><Link href="/sales/quotes/new"><button className="primary">+ عرض سعر</button></Link></p>}
    <MsgBox msg={msg} />{err && <div className="msg err">{err}</div>}
    <div className="card cards-as-list"><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>العميل</th><th>الإجمالي</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{data.map((q) => <tr key={q.id}><td><span className="num">{q.docNo ?? q.draftRef}</span></td><td><span className="num">{q.docDate}</span></td><td>{q.customerName}</td><td><span className="num">{money(q.total)} {q.currency}</span></td><td><span className="badge">{QS[q.status]}</span></td>
        <td>{q.status === "DRAFT" && can(me, "sales:approve") && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/sales-quotes/${q.id}/issue`, { method: "POST" }), "صدر العرض وأُعطي رقماً")}>إصدار</button>}
          {q.status === "DRAFT" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/sales-quotes/${q.id}`, { method: "DELETE" }), "حُذفت المسودة")}>حذف</button>}
          {q.status === "SENT" && <><button disabled={busy} onClick={() => run(() => api(`/api/sales-quotes/${q.id}/status`, { method: "POST", body: { status: "ACCEPTED" } }), "قُبل العرض")}>مقبول</button><button disabled={busy} onClick={() => run(() => api(`/api/sales-quotes/${q.id}/status`, { method: "POST", body: { status: "REJECTED" } }), "رُفض العرض")}>مرفوض</button></>}
          {(q.status === "SENT" || q.status === "ACCEPTED") && can(me, "sales:create") && <button disabled={busy} onClick={async () => { const r = await run(() => api<{ id: string }>(`/api/sales-quotes/${q.id}/convert`, { method: "POST", body: { saleType: "CREDIT", docDate: today() } }), "حُوِّل إلى فاتورة (مسودة)"); if (r) router.push(`/sales/${r.id}`); }}>تحويل لفاتورة</button>}
          {q.invoiceId && <Link href={`/sales/${q.invoiceId}`}><button>الفاتورة</button></Link>}</td></tr>)}
        {data.length === 0 && <tr><td colSpan={6}>لا توجد عروض</td></tr>}</tbody></table></div></>);
}
