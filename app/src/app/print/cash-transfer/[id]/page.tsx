"use client";
import { useParams } from "next/navigation";
import { tafqeet } from "@/lib/tafqeet";
import { Dl, OfficialSheet, useWho } from "@/components/official-sheet";
import { Loading, M, usePrint } from "@/components/print";

interface T { docNo: string | null; draftRef: string; docDate: string; from: string; to: string; currency: string; amount: string; notes: string | null; status: string }
export default function PrintTransfer() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<T>(`/api/cash-transfers/${id}`); const who = useWho();
  if (!d) return <Loading err={err} />;
  return (<OfficialSheet co={co} who={who} title="سند تحويل / تسليم عهدة" titleEn="CASH TRANSFER" pdfPath={`/print/cash-transfer/${id}`} status={d.status} leftLabel="المستلِم" leftName=""
    boxes={<><Dl title="بيانات السند" rows={[["رقم السند", d.docNo ?? d.draftRef, true], ["التاريخ", d.docDate, true], ["العملة", d.currency]]} /><Dl title="جهة التحويل" rows={[["من", d.from], ["إلى", d.to]]} /></>}
    final={<div className="sumrow"><div><div className="words"><small>المبلغ كتابةً</small>{d.currency === "IQD" ? tafqeet(Number(d.amount)) : tafqeet(Number(d.amount), "دولار أمريكي")}</div>{d.notes && <div className="notes"><b>ملاحظات:</b> {d.notes}</div>}</div>
      <table className="sum"><tbody><tr className="net"><td>المبلغ المحوَّل ({d.currency})</td><td><M v={d.amount} /></td></tr></tbody></table></div>}>
    <div style={{ height: 6 }} />
  </OfficialSheet>);
}
