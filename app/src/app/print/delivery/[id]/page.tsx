"use client";
import { useParams } from "next/navigation";
import { Dl, OfficialSheet, phonesOf, useWho } from "@/components/official-sheet";
import { Loading, M, usePrint } from "@/components/print";

interface D { docNo: string | null; draftRef: string; docDate: string; invoiceNo: string; customerName: string; customerPhones: string[] | null; customerAddress: string | null; recipientNote: string | null; status: string; lines: { productCode: string; productName: string; uom: string; qtyBase: string }[] }
export default function PrintDelivery() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<D>(`/api/delivery-notes/${id}`); const who = useWho();
  if (!d) return <Loading err={err} />;
  return (<OfficialSheet co={co} who={who} title="سند تسليم بضاعة" titleEn="DELIVERY NOTE" pdfPath={`/print/delivery/${id}`} status={d.status} leftLabel="المستلم" leftName={d.customerName}
    boxes={<><Dl title="بيانات السند" rows={[["رقم السند", d.docNo ?? d.draftRef, true], ["التاريخ", d.docDate, true], ["الفاتورة", d.invoiceNo, true]]} />
      <Dl title="بيانات العميل" rows={[["اسم العميل", d.customerName], ["الهاتف", phonesOf(d.customerPhones), true], ["العنوان", d.customerAddress]]} /></>}
    final={d.recipientNote ? <div className="notes"><b>ملاحظات:</b> {d.recipientNote}</div> : null}>
    <table className="items"><thead><tr><th style={{ width: "8%" }}>#</th><th>اسم الصنف</th><th style={{ width: "16%" }}>الوحدة الأساسية</th><th style={{ width: "20%" }}>الكمية المسلّمة</th></tr></thead>
      <tbody>{d.lines.map((l, i) => <tr key={i}><td className="c">{i + 1}</td><td>{l.productName}<div className="code num">{l.productCode}</div></td><td className="c">{l.uom}</td><td className="c"><M v={l.qtyBase} /></td></tr>)}</tbody></table>
  </OfficialSheet>);
}
