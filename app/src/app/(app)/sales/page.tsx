"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { money } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { StatusBadge, useLoad } from "@/components/ui";

interface Row { id: string; draftRef: string; docNo: string | null; docDate: string; customerName: string; saleType: string; currency: string; net: string; status: string }
export default function Sales() {
  const me = useMe(); const router = useRouter(); const { data, err } = useLoad<Row[]>("/api/sales-invoices", []);
  return (<>
    <h1>المبيعات</h1>
    <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {can(me, "sales:create") && <Link href="/sales/new"><button className="primary">+ فاتورة بيع</button></Link>}
      <Link href="/sales/quotes"><button>عروض الأسعار</button></Link><Link href="/sales/receipts"><button>سندات القبض</button></Link>
      <Link href="/sales/deliveries"><button>سندات التسليم</button></Link><Link href="/sales/returns"><button>المرتجعات</button></Link></p>
    {err && <div className="msg err">{err}</div>}
    <div className="card cards-as-list"><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>العميل</th><th>النوع</th><th>الصافي</th><th>الحالة</th></tr></thead>
      <tbody>{data.map((r) => <tr key={r.id} className="clickrow" tabIndex={0} onClick={() => router.push(`/sales/${r.id}`)} onKeyDown={(e) => { if (e.key === "Enter") router.push(`/sales/${r.id}`); }}><td><Link href={`/sales/${r.id}`}><span className="num">{r.docNo ?? r.draftRef}</span></Link></td><td><span className="num">{r.docDate}</span></td><td>{r.customerName}</td>
        <td>{r.saleType === "CASH" ? "نقدي" : "آجل"}</td><td><span className="num">{money(r.net)} {r.currency}</span></td><td><StatusBadge s={r.status} /></td></tr>)}
        {data.length === 0 && <tr><td colSpan={6}>لا توجد فواتير بعد</td></tr>}</tbody></table></div></>);
}
