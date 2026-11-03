"use client";
import { useParams } from "next/navigation";
import { tafqeet } from "@/lib/tafqeet";
import { Loading, M, Sheet, statusStamp, usePrint } from "@/components/print";

interface P { docNo: string | null; draftRef: string; docDate: string; supplierName: string; cashAccount: string; currency: string; amount: string; notes: string | null; status: string; allocations: { purchaseNo: string; amount: string }[] }
export default function PrintPayment() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<P>(`/api/supplier-payments/${id}`);
  if (!d || !co) return <Loading err={err} />;
  return (<Sheet co={co} title="سند صرف" stamp={statusStamp(d.status)} pdfPath={`/print/supplier-payment/${id}`} signer={["المحاسب", "المستلم", "المدير"]}
    meta={[["رقم السند", d.docNo ?? d.draftRef], ["التاريخ", d.docDate], ["صُرف إلى", d.supplierName], ["من", d.cashAccount], ["العملة", d.currency]]}
    footer={<><div className="words">{d.currency === "IQD" ? tafqeet(Number(d.amount)) : tafqeet(Number(d.amount), "دولار أمريكي")}</div>{d.notes && <p><b>ملاحظات:</b> {d.notes}</p>}</>}>
    <table className="tot"><tbody><tr><td>المبلغ ({d.currency})</td><td><M v={d.amount} /></td></tr></tbody></table>
    {d.allocations.length > 0 && <table><thead><tr><th>مخصص للفاتورة</th><th>المبلغ</th></tr></thead><tbody>{d.allocations.map((a) => <tr key={a.purchaseNo}><td className="num">{a.purchaseNo}</td><td><M v={a.amount} /></td></tr>)}</tbody></table>}</Sheet>);
}
