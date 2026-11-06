"use client";
import { useParams } from "next/navigation";
import { tafqeet } from "@/lib/tafqeet";
import { Loading, M, usePrint } from "@/components/print";
import { OfficialSheet, useWho } from "@/components/official-sheet";
import Decimal from "decimal.js";

interface R { docNo: string | null; draftRef: string; docDate: string; kind: string; customerName: string; customerPhones: string[] | null; customerAddress: string | null; cashAccount: string | null; currency: string; exchangeRate: string; amount: string; cashAmount?: string; external?: string; total: string; notes: string | null; status: string;
  allocations: { invoiceNo: string; invoiceNet: string; amount: string; paidToDate: string; returned: string; remaining: string; state: "PAID" | "PARTIAL" }[] }
export default function PrintReceipt() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<R>(`/api/customer-receipts/${id}`); const who = useWho();
  if (!d) return <Loading err={err} />;
  const credit = d.kind !== "CASH"; const stillOwed = d.allocations.reduce((s, a) => s.plus(a.remaining), new Decimal(0)); const allocated = d.allocations.reduce((s, a) => s.plus(a.amount), new Decimal(0)); const rest = new Decimal(d.total).minus(allocated);
  const words = d.currency === "IQD" ? tafqeet(Number(d.total)) : tafqeet(Number(d.total), "دولار أمريكي");
  return (<OfficialSheet co={co} who={who} title="سند قبض" titleEn="RECEIPT VOUCHER" pdfPath={`/print/receipt/${id}`} status={d.status} leftLabel="العميل (الدافع)" leftName={d.customerName}
    boxes={<>
      <div className="box"><h3>بيانات السند</h3><dl>
        <dt>رقم السند</dt><dd className="num">{d.docNo ?? d.draftRef}</dd><dt>التاريخ</dt><dd className="num">{d.docDate}</dd>
        <dt>{credit ? "المصدر" : "استُلم في"}</dt><dd>{credit ? "رصيد دائن للعميل" : d.cashAccount ?? "—"}</dd>
        <dt>العملة</dt><dd>{d.currency === "IQD" ? "دينار عراقي (IQD)" : `${d.currency} — سعر الصرف ${Number(d.exchangeRate)}`}</dd></dl></div>
      <div className="box"><h3>بيانات العميل</h3><dl>
        <dt>استلمنا من</dt><dd>{d.customerName}</dd><dt>الهاتف</dt><dd className="num">{d.customerPhones && d.customerPhones.length ? d.customerPhones.join(" - ") : "—"}</dd>
        <dt>العنوان</dt><dd>{d.customerAddress || "—"}</dd></dl></div></>}
    final={<div className="sumrow">
      <div><div className="words"><small>المبلغ كتابةً</small>{words}</div>{d.notes && <div className="notes"><b>ملاحظات:</b> {d.notes}</div>}</div>
      <table className="sum"><tbody>
        <tr className="net"><td>{"المبلغ المستلم"} ({d.currency})</td><td><M v={d.total} /></td></tr>
        {d.allocations.length > 0 && <tr><td>المخصَّص للفواتير</td><td><M v={allocated.toString()} /></td></tr>}
        {d.allocations.length > 0 && <tr className="due"><td>المتبقي على الفواتير بعد هذا السند</td><td><M v={stillOwed.toString()} /></td></tr>}
        {!credit && rest.gt(0) && <tr className="due"><td>رصيد دائن غير مخصَّص</td><td><M v={rest.toString()} /></td></tr>}
      </tbody></table></div>}>
    {d.allocations.length > 0 ? <table className="items"><thead><tr><th style={{ width: "5%" }}>#</th><th>الفاتورة</th><th style={{ width: "15%" }}>قيمة الفاتورة</th><th style={{ width: "15%" }}>هذا السند</th><th style={{ width: "15%" }}>إجمالي المسدَّد</th><th style={{ width: "15%" }}>المتبقي</th><th style={{ width: "13%" }}>الحالة</th></tr></thead>
      <tbody>{d.allocations.map((a, i) => <tr key={a.invoiceNo}><td className="c">{i + 1}</td><td className="num">{a.invoiceNo}</td><td className="e"><M v={a.invoiceNet} /></td><td className="e"><M v={a.amount} /></td><td className="e"><M v={a.paidToDate} /></td><td className="e"><b><M v={a.remaining} /></b></td><td className="c"><b style={{ color: a.state === "PAID" ? "#176b2c" : "#8a5a00" }}>{a.state === "PAID" ? "مسدّدة بالكامل" : "مسدّد جزئي"}</b></td></tr>)}</tbody></table>
      : <p style={{ margin: "14px 0", color: "#4a5568" }}>لم يُخصَّص هذا المبلغ لفاتورة محددة؛ سُجّل رصيداً دائناً للعميل.</p>}
  </OfficialSheet>);
}
