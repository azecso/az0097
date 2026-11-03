"use client";
import { useParams } from "next/navigation";
import { Loading, M, Sheet, usePrint } from "@/components/print";

interface Q { docNo: string | null; draftRef: string; docDate: string; validUntil: string | null; customerName: string; currency: string; discount: string; total: string; terms: string | null; notes: string | null; status: string;
  lines: { lineNo: number; productCode: string; productName: string; uom: string; qty: string; unitPrice: string; lineDiscount: string; lineTotal: string }[] }
export default function PrintQuote() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<Q>(`/api/sales-quotes/${id}`);
  if (!d || !co) return <Loading err={err} />;
  return (<Sheet co={co} title="عرض سعر" stamp={d.status === "DRAFT" ? "مسودة — غير نهائي" : ""} pdfPath={`/print/sales-quote/${id}`} signer={["مُعدّ العرض", "موافقة العميل", "المدير"]}
    meta={[["رقم العرض", d.docNo ?? d.draftRef], ["التاريخ", d.docDate], ["صالح حتى", d.validUntil], ["العميل", d.customerName], ["العملة", d.currency]]}
    footer={<>{(d.terms || d.notes) && <p><b>الشروط والملاحظات:</b> {d.terms} {d.notes}</p>}</>}>
    <table><thead><tr><th>#</th><th>الصنف</th><th>الوحدة</th><th>الكمية</th><th>السعر</th><th>الخصم</th><th>الإجمالي</th></tr></thead>
      <tbody>{d.lines.map((l) => <tr key={l.lineNo}><td>{l.lineNo}</td><td>{l.productCode} — {l.productName}</td><td>{l.uom}</td><td><M v={l.qty} /></td><td><M v={l.unitPrice} /></td><td><M v={l.lineDiscount} /></td><td><M v={l.lineTotal} /></td></tr>)}</tbody></table>
    <table className="tot"><tbody>{Number(d.discount) > 0 && <tr><td>الخصم</td><td><M v={d.discount} /></td></tr>}<tr><td>الإجمالي ({d.currency})</td><td><M v={d.total} /></td></tr></tbody></table></Sheet>);
}
