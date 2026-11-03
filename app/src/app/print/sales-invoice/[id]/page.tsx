"use client";
import { useParams } from "next/navigation";
import { tafqeet } from "@/lib/tafqeet";
import { Loading, M, Sheet, statusStamp, usePrint } from "@/components/print";

interface Inv { docNo: string | null; draftRef: string; docDate: string; dueDate: string | null; customerName: string; saleType: string; currency: string; exchangeRate: string; gross: string; discount: string; net: string; terms: string | null; notes: string | null; status: string; collected?: string; outstanding?: string;
  lines: { lineNo: number; productCode: string; productName: string; uom: string; qty: string; unitPrice: string; lineDiscount: string; lineTotal: string }[] }
export default function PrintInvoice() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<Inv>(`/api/sales-invoices/${id}`);
  if (!d || !co) return <Loading err={err} />;
  return (<Sheet co={co} title="فاتورة بيع" stamp={statusStamp(d.status)} pdfPath={`/print/sales-invoice/${id}`}
    meta={[["رقم الفاتورة", d.docNo ?? d.draftRef], ["التاريخ", d.docDate], ["العميل", d.customerName], ["نوع البيع", d.saleType === "CASH" ? "نقدي" : "آجل"], ["الاستحقاق", d.dueDate], ["العملة", d.currency !== "IQD" ? `${d.currency} (الصرف ${money0(d.exchangeRate)})` : "IQD"]]}
    footer={<>{d.currency === "IQD" && <div className="words">{tafqeet(Number(d.net))}</div>}{(d.terms || d.notes) && <p><b>الشروط والملاحظات:</b> {d.terms} {d.notes}</p>}</>}>
    <table><thead><tr><th>#</th><th>الصنف</th><th>الوحدة</th><th>الكمية</th><th>السعر</th><th>الخصم</th><th>الإجمالي</th></tr></thead>
      <tbody>{d.lines.map((l) => <tr key={l.lineNo}><td>{l.lineNo}</td><td>{l.productCode} — {l.productName}</td><td>{l.uom}</td><td><M v={l.qty} /></td><td><M v={l.unitPrice} /></td><td><M v={l.lineDiscount} /></td><td><M v={l.lineTotal} /></td></tr>)}</tbody></table>
    <table className="tot"><tbody><tr><td>الإجمالي</td><td><M v={d.gross} /></td></tr>{Number(d.discount) > 0 && <tr><td>الخصم</td><td><M v={d.discount} /></td></tr>}<tr><td>الصافي ({d.currency})</td><td><M v={d.net} /></td></tr>
      {d.collected !== undefined && <><tr><td>المدفوع</td><td><M v={d.collected} /></td></tr><tr><td>المتبقي</td><td><M v={d.outstanding} /></td></tr></>}</tbody></table></Sheet>);
}
const money0 = (v: string) => String(Number(v));
