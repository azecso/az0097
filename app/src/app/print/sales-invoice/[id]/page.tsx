"use client";
import { useParams } from "next/navigation";
import Decimal from "decimal.js";
import { tafqeet } from "@/lib/tafqeet";
import { Loading, M, usePrint } from "@/components/print";
import { OfficialSheet, useWho } from "@/components/official-sheet";

interface Inv { docNo: string | null; draftRef: string; docDate: string; dueDate: string | null; customerName: string; customerPhones: string[] | null; customerAddress: string | null;
  saleType: string; currency: string; exchangeRate: string; gross: string; discount: string; net: string; terms: string | null; notes: string | null; status: string;
  collected?: string; external?: string; appliedToReceivable?: string; outstanding?: string;
  lines: { lineNo: number; productCode: string; productName: string; uom: string; qty: string; unitPrice: string; lineDiscount: string; lineTotal: string }[] }

export default function PrintInvoice() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<Inv>(`/api/sales-invoices/${id}`); const who = useWho();
  if (!d) return <Loading err={err} />;
  const posted = d.collected !== undefined; const hasDisc = Number(d.discount) > 0 || d.lines.some((l) => Number(l.lineDiscount) > 0);
  const words = d.currency === "IQD" ? tafqeet(Number(d.net)) : tafqeet(Number(d.net), "دولار أمريكي");
  return (<OfficialSheet co={co} who={who} title="فاتورة بيع" titleEn="SALES INVOICE" pdfPath={`/print/sales-invoice/${id}`} status={d.status} leftLabel="المستلم" leftName={d.customerName}
    boxes={<>
      <div className="box"><h3>بيانات الفاتورة</h3><dl>
        <dt>رقم الفاتورة</dt><dd className="num">{d.docNo ?? d.draftRef}</dd><dt>التاريخ</dt><dd className="num">{d.docDate}</dd>
        <dt>تاريخ الاستحقاق</dt><dd className="num">{d.dueDate ?? "—"}</dd><dt>نوع البيع</dt><dd>{d.saleType === "CASH" ? "نقدي" : "آجل"}</dd>
        <dt>العملة</dt><dd>{d.currency === "IQD" ? "دينار عراقي (IQD)" : `${d.currency} — سعر الصرف ${Number(d.exchangeRate)}`}</dd></dl></div>
      <div className="box"><h3>بيانات العميل</h3><dl>
        <dt>اسم العميل</dt><dd>{d.customerName}</dd><dt>الهاتف</dt><dd className="num">{d.customerPhones && d.customerPhones.length ? d.customerPhones.join(" - ") : "—"}</dd>
        <dt>العنوان</dt><dd>{d.customerAddress || "—"}</dd></dl></div></>}
    final={<div className="sumrow">
      <div><div className="words"><small>المبلغ كتابةً</small>{words}</div>{(d.terms || d.notes) && <div className="notes"><b>الشروط والملاحظات:</b> {[d.terms, d.notes].filter(Boolean).join(" — ")}</div>}</div>
      <table className="sum"><tbody>
        {Number(d.discount) > 0 && <><tr><td>الإجمالي قبل الخصم</td><td><M v={d.gross} /></td></tr><tr><td>الخصم</td><td><M v={d.discount} /></td></tr></>}
        <tr className="net"><td>صافي الفاتورة ({d.currency})</td><td><M v={d.net} /></td></tr>
        {posted && <><tr><td>المدفوع</td><td><M v={new Decimal(d.collected ?? 0).plus(d.external ?? 0).toString()} /></td></tr>{Number(d.appliedToReceivable) > 0 && <tr><td>مرتجعات / إشعارات دائنة</td><td><M v={d.appliedToReceivable} /></td></tr>}
          <tr className="due"><td>المتبقي</td><td><M v={d.outstanding} /></td></tr></>}
      </tbody></table></div>}>
    <table className="items"><thead><tr><th style={{ width: "6%" }}>#</th><th>اسم الصنف</th><th style={{ width: "9%" }}>الوحدة</th><th style={{ width: "10%" }}>الكمية</th><th style={{ width: "15%" }}>سعر الوحدة</th>{hasDisc && <th style={{ width: "11%" }}>الخصم</th>}<th style={{ width: "16%" }}>الإجمالي</th></tr></thead>
      <tbody>{d.lines.map((l) => <tr key={l.lineNo}><td className="c">{l.lineNo}</td><td>{l.productName}<div className="code num">{l.productCode}</div></td><td className="c">{l.uom}</td><td className="c"><M v={l.qty} /></td><td className="e"><M v={l.unitPrice} /></td>{hasDisc && <td className="e"><M v={l.lineDiscount} /></td>}<td className="e"><M v={l.lineTotal} /></td></tr>)}</tbody></table>
  </OfficialSheet>);
}
