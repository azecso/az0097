"use client";
import { useParams } from "next/navigation";
import { Dl, OfficialSheet, phonesOf, useWho } from "@/components/official-sheet";
import { tafqeet } from "@/lib/tafqeet";
import { Loading, M, usePrint } from "@/components/print";

interface P { docNo: string | null; draftRef: string; docDate: string; supplierName: string; supplierPhones: string[] | null; supplierAddress: string | null; supplierInvoiceNo: string | null; paymentType: string; currency: string; total: string; status: string; notes: string | null; dueDate: string | null;
  lines: { lineNo: number; productCode: string; productName: string; uom: string; qty: string; unitPrice: string; lineTotal: string }[]; charges: { kind: string; description: string | null; amount: string; capitalize: boolean }[] }
const KIND: Record<string, string> = { TRANSPORT: "نقل", LOADING: "تحميل", CUSTOMS: "جمارك", OTHER: "أخرى" };
export default function PrintPurchase() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<P>(`/api/purchases/${id}`); const who = useWho();
  if (!d) return <Loading err={err} />;
  return (<OfficialSheet co={co} who={who} title="فاتورة شراء" titleEn="PURCHASE INVOICE" pdfPath={`/print/purchase/${id}`} status={d.status} leftLabel="أمين المخزن" leftName=""
    boxes={<><Dl title="بيانات الفاتورة" rows={[["الرقم", d.docNo ?? d.draftRef, true], ["التاريخ", d.docDate, true], ["فاتورة المورد", d.supplierInvoiceNo, true], ["الدفع", d.paymentType === "CASH" ? "نقدي" : "آجل"], ["العملة", d.currency]]} />
      <Dl title="بيانات المورد" rows={[["اسم المورد", d.supplierName], ["الهاتف", phonesOf(d.supplierPhones), true], ["العنوان", d.supplierAddress]]} /></>}
    final={<div className="sumrow"><div><div className="words"><small>المبلغ كتابةً</small>{d.currency === "IQD" ? tafqeet(Number(d.total)) : tafqeet(Number(d.total), "دولار أمريكي")}</div>{d.notes && <div className="notes"><b>ملاحظات:</b> {d.notes}</div>}</div>
      <table className="sum"><tbody><tr className="net"><td>الإجمالي ({d.currency})</td><td><M v={d.total} /></td></tr></tbody></table></div>}>
    <table className="items"><thead><tr><th style={{ width: "6%" }}>#</th><th>اسم الصنف</th><th style={{ width: "9%" }}>الوحدة</th><th style={{ width: "11%" }}>الكمية</th><th style={{ width: "16%" }}>سعر الوحدة</th><th style={{ width: "17%" }}>الإجمالي</th></tr></thead>
      <tbody>{d.lines.map((l) => <tr key={l.lineNo}><td className="c">{l.lineNo}</td><td>{l.productName}<div className="code num">{l.productCode}</div></td><td className="c">{l.uom}</td><td className="c"><M v={l.qty} /></td><td className="e"><M v={l.unitPrice} /></td><td className="e"><M v={l.lineTotal} /></td></tr>)}</tbody></table>
    {d.charges.length > 0 && <table className="items"><thead><tr><th>تكاليف إضافية</th><th style={{ width: "20%" }}>المبلغ</th><th style={{ width: "26%" }}>المعالجة</th></tr></thead>
      <tbody>{d.charges.map((c, i) => <tr key={i}><td>{KIND[c.kind]} {c.description}</td><td className="e"><M v={c.amount} /></td><td className="c">{c.capitalize ? "ضمن كلفة المخزون" : "مصروف"}</td></tr>)}</tbody></table>}
  </OfficialSheet>);
}
