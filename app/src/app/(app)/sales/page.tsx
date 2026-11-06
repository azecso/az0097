"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { payState, totalsByCurrency } from "@/lib/pay";
import { money } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { StatusBadge, useLoad } from "@/components/ui";

interface Row { id: string; draftRef: string; docNo: string | null; docDate: string; customerName: string; saleType: string; currency: string; net: string; status: string; outstanding: string | null; creditCovered?: string }
export default function Sales() {
  const me = useMe(); const router = useRouter(); const [cancelled, setCancelled] = useState(false); const { data, err } = useLoad<Row[]>(cancelled ? "/api/sales-invoices?status=REVERSED" : "/api/sales-invoices", []);
  return (<>
    <h1>المبيعات</h1>
    <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {can(me, "sales:create") && <Link href="/sales/new"><button className="primary">+ فاتورة بيع</button></Link>}
      <Link href="/sales/quotes"><button>عروض الأسعار</button></Link><Link href="/sales/receipts"><button>سندات القبض</button></Link>
      <Link href="/sales/deliveries"><button>سندات التسليم</button></Link><Link href="/sales/returns"><button>المرتجعات</button></Link></p>
    <label style={{ display: "inline-flex", gap: 6, alignItems: "center", margin: "4px 0" }}><input type="checkbox" checked={cancelled} onChange={(e) => setCancelled(e.target.checked)} />إظهار الفواتير المحذوفة</label>
    {err && <div className="msg err">{err}</div>}
    <div className="card cards-as-list"><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>العميل</th><th>النوع</th><th>الصافي</th><th>الحالة</th></tr></thead>
      <tbody>{data.map((r) => <tr key={r.id} className={`clickrow${payState(r.status, r.net, r.outstanding, r.creditCovered)?.key === "PAID" ? " paidrow" : ""}`} tabIndex={0} onClick={() => router.push(`/sales/${r.id}`)} onKeyDown={(e) => { if (e.key === "Enter") router.push(`/sales/${r.id}`); }}><td><Link href={`/sales/${r.id}`}><span className="num">{r.docNo ?? r.draftRef}</span></Link></td><td><span className="num">{r.docDate}</span></td><td>{r.customerName}</td>
        <td>{r.saleType === "CASH" ? "نقدي" : "آجل"}</td><td><span className="num">{money(r.net)} {r.currency}</span></td><td><StatusBadge s={r.status} />{(() => { const ps = payState(r.status, r.net, r.outstanding, r.creditCovered); return ps && <> <span className={`paytag ${ps.key.toLowerCase()}`}>{ps.key === "PAID" ? "مقبوضة" : ps.key === "PARTIAL" ? "مسدد جزئي" : "غير مسددة"}</span>{ps.key !== "UNPAID" && ps.key !== "PAID" && <span className="num"> · المتبقي {money(ps.outstanding)} {r.currency}</span>}{Number(r.creditCovered) > 0 && <small> (سُدّد منها {money(r.creditCovered)} من دفعة غير مخصَّصة)</small>}</>; })()}</td></tr>)}
        {data.length === 0 && <tr><td colSpan={6}>لا توجد فواتير بعد</td></tr>}</tbody><tfoot>{totalsByCurrency(data, (r) => r.net).map((t) => <tr key={t.currency} style={{ fontWeight: 700 }}><td colSpan={4}>المجموع ({t.currency}) — للمرحَّلة فقط · مقبوضة: <span className="num">{money(t.paid)}</span> · المتبقي: <span className="num">{money(t.outstanding)}</span></td><td><span className="num">{money(t.total)} {t.currency}</span></td><td></td></tr>)}</tfoot></table></div></>);
}
