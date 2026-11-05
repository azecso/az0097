"use client";
import { useParams } from "next/navigation";
import { tafqeet } from "@/lib/tafqeet";
import { Dl, OfficialSheet, useWho } from "@/components/official-sheet";
import { Loading, M, usePrint } from "@/components/print";

interface R { docNo: string; returnedAt: string; currency: string; amount: string; recipientName: string; refNo: string | null; method: string; note: string | null }
const METHODS: Record<string, string> = { CASH: "نقداً", TRANSFER: "حوالة", CHEQUE: "صك", OTHER: "أخرى" };
export default function PrintCapitalReturn() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<R>(`/api/capital-returns/${id}`); const who = useWho();
  if (!d) return <Loading err={err} />;
  return (<OfficialSheet co={co} who={who} title="وصل إرجاع رأس مال" titleEn="CAPITAL RETURN RECEIPT" pdfPath={`/print/capital-return/${id}`} leftLabel="المستلم" leftName={d.recipientName}
    boxes={<><Dl title="بيانات الوصل" rows={[["رقم الوصل", d.docNo, true], ["التاريخ والوقت", new Date(d.returnedAt).toLocaleString("en-GB", { hour12: false }).replace(",", ""), true], ["رقم الوصل/الفاتورة", d.refNo, true], ["الطريقة", METHODS[d.method]], ["العملة", d.currency]]} />
      <Dl title="المستلم" rows={[["اسم المستلم", d.recipientName]]} /></>}
    final={<div className="sumrow"><div><div className="words"><small>المبلغ كتابةً</small>{d.currency === "IQD" ? tafqeet(Number(d.amount)) : tafqeet(Number(d.amount), "دولار أمريكي")}</div>{d.note && <div className="notes"><b>ملاحظات:</b> {d.note}</div>}<div className="notes">سجل معلوماتي: لا يمثل قيداً محاسبياً.</div></div>
      <table className="sum"><tbody><tr className="net"><td>المبلغ المُرجَع ({d.currency})</td><td><M v={d.amount} /></td></tr></tbody></table></div>}>
    <div style={{ height: 6 }} />
  </OfficialSheet>);
}
