"use client";
import { useParams } from "next/navigation";
import { tafqeet } from "@/lib/tafqeet";
import { Loading, M, Sheet, usePrint } from "@/components/print";

interface R { docNo: string; returnedAt: string; currency: string; amount: string; recipientName: string; refNo: string | null; method: string; note: string | null }
const METHODS: Record<string, string> = { CASH: "نقداً", TRANSFER: "حوالة", CHEQUE: "صك", OTHER: "أخرى" };
export default function PrintCapitalReturn() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<R>(`/api/capital-returns/${id}`);
  if (!d || !co) return <Loading err={err} />;
  return (<Sheet co={co} title="وصل إرجاع رأس مال" pdfPath={`/print/capital-return/${id}`} signer={["المحاسب", "المستلم", "المدير"]}
    meta={[["رقم الوصل", d.docNo], ["التاريخ والوقت", new Date(d.returnedAt).toLocaleString("en-GB", { hour12: false }).replace(",", "")], ["اسم المستلم", d.recipientName], ["رقم الوصل/الفاتورة", d.refNo], ["الطريقة", METHODS[d.method]], ["العملة", d.currency]]}
    footer={<><div className="words">{d.currency === "IQD" ? tafqeet(Number(d.amount)) : tafqeet(Number(d.amount), "دولار أمريكي")}</div>{d.note && <p><b>ملاحظات:</b> {d.note}</p>}<p style={{ fontSize: 11 }}>سجل معلوماتي: لا يمثل قيداً محاسبياً.</p></>}>
    <table className="tot"><tbody><tr><td>المبلغ المُرجَع ({d.currency})</td><td><M v={d.amount} /></td></tr></tbody></table>
  </Sheet>);
}
