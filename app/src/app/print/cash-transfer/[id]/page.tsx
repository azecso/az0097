"use client";
import { useParams } from "next/navigation";
import { tafqeet } from "@/lib/tafqeet";
import { Loading, M, Sheet, statusStamp, usePrint } from "@/components/print";

interface T { docNo: string | null; draftRef: string; docDate: string; from: string; to: string; currency: string; amount: string; notes: string | null; status: string }
export default function PrintTransfer() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<T>(`/api/cash-transfers/${id}`);
  if (!d || !co) return <Loading err={err} />;
  return (<Sheet co={co} title="سند تحويل / تسليم عهدة" stamp={statusStamp(d.status)} pdfPath={`/print/cash-transfer/${id}`} signer={["المسلِّم", "المستلِم", "المحاسب"]}
    meta={[["رقم السند", d.docNo ?? d.draftRef], ["التاريخ", d.docDate], ["من", d.from], ["إلى", d.to], ["العملة", d.currency]]} footer={<><div className="words">{d.currency === "IQD" ? tafqeet(Number(d.amount)) : tafqeet(Number(d.amount), "دولار أمريكي")}</div>{d.notes && <p>{d.notes}</p>}</>}>
    <table className="tot"><tbody><tr><td>المبلغ ({d.currency})</td><td><M v={d.amount} /></td></tr></tbody></table></Sheet>);
}
