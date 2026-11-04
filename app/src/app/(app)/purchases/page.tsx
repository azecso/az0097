"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { payState, totalsByCurrency } from "@/lib/pay";
import { money } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { StatusBadge, useLoad } from "@/components/ui";

interface Row { id: string; draftRef: string; docNo: string | null; docDate: string; supplierName: string; paymentType: string; currency: string; total: string; status: string; dueDate: string | null; outstanding: string | null }
export default function Purchases() {
  const me = useMe(); const router = useRouter(); const { data, err } = useLoad<Row[]>("/api/purchases", []);
  return (<>
    <h1>المشتريات</h1>
    <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {can(me, "purchase:create") && <Link href="/purchases/new"><button className="primary">+ فاتورة شراء</button></Link>}
      <Link href="/purchases/payments"><button>سندات الصرف</button></Link></p>
    {err && <div className="msg err">{err}</div>}
    <div className="card cards-as-list"><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>المورد</th><th>الدفع</th><th>الإجمالي</th><th>الحالة</th></tr></thead>
      <tbody>{data.map((r) => <tr key={r.id} className={`clickrow${payState(r.status, r.total, r.outstanding)?.key === "PAID" ? " paidrow" : ""}`} tabIndex={0} onClick={() => router.push(`/purchases/${r.id}`)} onKeyDown={(e) => { if (e.key === "Enter") router.push(`/purchases/${r.id}`); }}><td><Link href={`/purchases/${r.id}`}><span className="num">{r.docNo ?? r.draftRef}</span></Link></td><td><span className="num">{r.docDate}</span></td><td>{r.supplierName}</td>
        <td>{r.paymentType === "CASH" ? "نقدي" : "آجل"}</td><td><span className="num">{money(r.total)} {r.currency}</span></td><td><StatusBadge s={r.status} />{(() => { const ps = payState(r.status, r.total, r.outstanding); return ps && <> <span className={`paytag ${ps.key.toLowerCase()}`}>{ps.key === "PAID" ? "مدفوعة" : ps.key === "PARTIAL" ? "مسدد جزئي" : "غير مسددة"}</span>{ps.key !== "UNPAID" && ps.key !== "PAID" && <span className="num"> · المتبقي {money(ps.outstanding)} {r.currency}</span>}</>; })()}</td></tr>)}
        {data.length === 0 && <tr><td colSpan={6}>لا توجد فواتير بعد</td></tr>}</tbody><tfoot>{totalsByCurrency(data, (r) => r.total).map((t) => <tr key={t.currency} style={{ fontWeight: 700 }}><td colSpan={4}>المجموع ({t.currency}) — للمرحَّلة فقط · مدفوعة: <span className="num">{money(t.paid)}</span> · المتبقي: <span className="num">{money(t.outstanding)}</span></td><td><span className="num">{money(t.total)} {t.currency}</span></td><td></td></tr>)}</tfoot></table></div></>);
}
