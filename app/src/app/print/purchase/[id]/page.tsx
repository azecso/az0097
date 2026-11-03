"use client";
import { useParams } from "next/navigation";
import { Loading, M, Sheet, statusStamp, usePrint } from "@/components/print";

interface P { docNo: string | null; draftRef: string; docDate: string; supplierName: string; supplierInvoiceNo: string | null; paymentType: string; currency: string; total: string; status: string; notes: string | null;
  lines: { lineNo: number; productCode: string; productName: string; uom: string; qty: string; unitPrice: string; lineTotal: string }[]; charges: { kind: string; description: string | null; amount: string; capitalize: boolean }[] }
const KIND: Record<string, string> = { TRANSPORT: "نقل", LOADING: "تحميل", CUSTOMS: "جمارك", OTHER: "أخرى" };
export default function PrintPurchase() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<P>(`/api/purchases/${id}`);
  if (!d || !co) return <Loading err={err} />;
  return (<Sheet co={co} title="فاتورة شراء" stamp={statusStamp(d.status)} pdfPath={`/print/purchase/${id}`} signer={["المحاسب", "أمين المخزن", "المدير"]}
    meta={[["الرقم", d.docNo ?? d.draftRef], ["التاريخ", d.docDate], ["المورد", d.supplierName], ["فاتورة المورد", d.supplierInvoiceNo], ["الدفع", d.paymentType === "CASH" ? "نقدي" : "آجل"], ["العملة", d.currency]]}>
    <table><thead><tr><th>#</th><th>الصنف</th><th>الوحدة</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr></thead>
      <tbody>{d.lines.map((l) => <tr key={l.lineNo}><td>{l.lineNo}</td><td>{l.productCode} — {l.productName}</td><td>{l.uom}</td><td><M v={l.qty} /></td><td><M v={l.unitPrice} /></td><td><M v={l.lineTotal} /></td></tr>)}</tbody></table>
    {d.charges.length > 0 && <table><thead><tr><th>تكاليف إضافية</th><th>المبلغ</th><th>المعالجة</th></tr></thead><tbody>{d.charges.map((c, i) => <tr key={i}><td>{KIND[c.kind]} {c.description}</td><td><M v={c.amount} /></td><td>{c.capitalize ? "ضمن كلفة المخزون" : "مصروف"}</td></tr>)}</tbody></table>}
    <table className="tot"><tbody><tr><td>الإجمالي ({d.currency})</td><td><M v={d.total} /></td></tr></tbody></table></Sheet>);
}
