"use client";
import { useParams } from "next/navigation";
import { tafqeet } from "@/lib/tafqeet";
import { Loading, M, Sheet, statusStamp, usePrint } from "@/components/print";

interface R { docNo: string | null; draftRef: string; docDate: string; kind: string; customerName: string; cashAccount: string | null; currency: string; amount: string; notes: string | null; status: string; allocations: { invoiceNo: string; amount: string }[] }
export default function PrintReceipt() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<R>(`/api/customer-receipts/${id}`);
  if (!d || !co) return <Loading err={err} />;
  return (<Sheet co={co} title={d.kind === "CASH" ? "سند قبض" : "تسوية رصيد دائن"} stamp={statusStamp(d.status)} pdfPath={`/print/receipt/${id}`} signer={["المحاسب", "المستلم", "الدافع"]}
    meta={[["رقم السند", d.docNo ?? d.draftRef], ["التاريخ", d.docDate], ["استلمنا من", d.customerName], ["في", d.cashAccount], ["العملة", d.currency]]}
    footer={<><div className="words">{d.currency === "IQD" ? tafqeet(Number(d.amount)) : tafqeet(Number(d.amount), "دولار أمريكي")}</div>{d.notes && <p><b>ملاحظات:</b> {d.notes}</p>}</>}>
    <table className="tot"><tbody><tr><td>المبلغ ({d.currency})</td><td><M v={d.amount} /></td></tr></tbody></table>
    {d.allocations.length > 0 && <table><thead><tr><th>مخصص للفاتورة</th><th>المبلغ</th></tr></thead><tbody>{d.allocations.map((a) => <tr key={a.invoiceNo}><td className="num">{a.invoiceNo}</td><td><M v={a.amount} /></td></tr>)}</tbody></table>}</Sheet>);
}
