"use client";
import { useParams } from "next/navigation";
import { tafqeet } from "@/lib/tafqeet";
import { Dl, OfficialSheet, phonesOf, useWho } from "@/components/official-sheet";
import { Loading, M, usePrint } from "@/components/print";

interface Q { docNo: string | null; draftRef: string; docDate: string; validUntil: string | null; customerName: string; customerPhones: string[] | null; customerAddress: string | null; currency: string; discount: string; total: string; terms: string | null; notes: string | null; status: string;
  lines: { lineNo: number; productCode: string; productName: string; uom: string; qty: string; unitPrice: string; lineDiscount: string; lineTotal: string }[] }
export default function PrintQuote() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<Q>(`/api/sales-quotes/${id}`); const who = useWho();
  if (!d) return <Loading err={err} />;
  const hasDisc = Number(d.discount) > 0 || d.lines.some((l) => Number(l.lineDiscount) > 0);
  return (<OfficialSheet co={co} who={who} title="عرض سعر" titleEn="QUOTATION" pdfPath={`/print/sales-quote/${id}`} status={d.status} leftLabel="موافقة العميل" leftName={d.customerName}
    boxes={<><Dl title="بيانات العرض" rows={[["رقم العرض", d.docNo ?? d.draftRef, true], ["التاريخ", d.docDate, true], ["صالح حتى", d.validUntil, true], ["العملة", d.currency]]} />
      <Dl title="بيانات العميل" rows={[["اسم العميل", d.customerName], ["الهاتف", phonesOf(d.customerPhones), true], ["العنوان", d.customerAddress]]} /></>}
    final={<div className="sumrow"><div><div className="words"><small>المبلغ كتابةً</small>{d.currency === "IQD" ? tafqeet(Number(d.total)) : tafqeet(Number(d.total), "دولار أمريكي")}</div>{(d.terms || d.notes) && <div className="notes"><b>الشروط والملاحظات:</b> {[d.terms, d.notes].filter(Boolean).join(" — ")}</div>}</div>
      <table className="sum"><tbody>{Number(d.discount) > 0 && <tr><td>الخصم</td><td><M v={d.discount} /></td></tr>}<tr className="net"><td>إجمالي العرض ({d.currency})</td><td><M v={d.total} /></td></tr></tbody></table></div>}>
    <table className="items"><thead><tr><th style={{ width: "6%" }}>#</th><th>اسم الصنف</th><th style={{ width: "9%" }}>الوحدة</th><th style={{ width: "10%" }}>الكمية</th><th style={{ width: "15%" }}>سعر الوحدة</th>{hasDisc && <th style={{ width: "11%" }}>الخصم</th>}<th style={{ width: "16%" }}>الإجمالي</th></tr></thead>
      <tbody>{d.lines.map((l) => <tr key={l.lineNo}><td className="c">{l.lineNo}</td><td>{l.productName}<div className="code num">{l.productCode}</div></td><td className="c">{l.uom}</td><td className="c"><M v={l.qty} /></td><td className="e"><M v={l.unitPrice} /></td>{hasDisc && <td className="e"><M v={l.lineDiscount} /></td>}<td className="e"><M v={l.lineTotal} /></td></tr>)}</tbody></table>
  </OfficialSheet>);
}
