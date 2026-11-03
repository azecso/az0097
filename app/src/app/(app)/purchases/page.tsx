"use client";
import Link from "next/link";
import { money } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { StatusBadge, useLoad } from "@/components/ui";

interface Row { id: string; draftRef: string; docNo: string | null; docDate: string; supplierName: string; paymentType: string; currency: string; total: string; status: string; dueDate: string | null }
export default function Purchases() {
  const me = useMe(); const { data, err } = useLoad<Row[]>("/api/purchases", []);
  return (<>
    <h1>المشتريات</h1>
    <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {can(me, "purchase:create") && <Link href="/purchases/new"><button className="primary">+ فاتورة شراء</button></Link>}
      <Link href="/purchases/payments"><button>سندات الصرف</button></Link></p>
    {err && <div className="msg err">{err}</div>}
    <div className="card cards-as-list"><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>المورد</th><th>الدفع</th><th>الإجمالي</th><th>الحالة</th></tr></thead>
      <tbody>{data.map((r) => <tr key={r.id}><td><Link href={`/purchases/${r.id}`}><span className="num">{r.docNo ?? r.draftRef}</span></Link></td><td><span className="num">{r.docDate}</span></td><td>{r.supplierName}</td>
        <td>{r.paymentType === "CASH" ? "نقدي" : "آجل"}</td><td><span className="num">{money(r.total)} {r.currency}</span></td><td><StatusBadge s={r.status} /></td></tr>)}
        {data.length === 0 && <tr><td colSpan={6}>لا توجد فواتير بعد</td></tr>}</tbody></table></div></>);
}
