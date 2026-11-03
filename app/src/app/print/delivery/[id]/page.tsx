"use client";
import { useParams } from "next/navigation";
import { Loading, M, Sheet, statusStamp, usePrint } from "@/components/print";

interface D { docNo: string | null; draftRef: string; docDate: string; invoiceNo: string; customerName: string; recipientNote: string | null; status: string; lines: { productCode: string; productName: string; uom: string; qtyBase: string }[] }
export default function PrintDelivery() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<D>(`/api/delivery-notes/${id}`);
  if (!d || !co) return <Loading err={err} />;
  return (<Sheet co={co} title="سند تسليم بضاعة" stamp={statusStamp(d.status)} pdfPath={`/print/delivery/${id}`} signer={["أمين المخزن", "المستلم (الاسم والتوقيع)", "المحاسب"]}
    meta={[["رقم السند", d.docNo ?? d.draftRef], ["التاريخ", d.docDate], ["الفاتورة", d.invoiceNo], ["العميل", d.customerName]]} footer={d.recipientNote ? <p><b>ملاحظات:</b> {d.recipientNote}</p> : null}>
    <table><thead><tr><th>#</th><th>الصنف</th><th>الوحدة الأساسية</th><th>الكمية المسلّمة</th></tr></thead><tbody>{d.lines.map((l, i) => <tr key={i}><td>{i + 1}</td><td>{l.productCode} — {l.productName}</td><td>{l.uom}</td><td><M v={l.qtyBase} /></td></tr>)}</tbody></table></Sheet>);
}
