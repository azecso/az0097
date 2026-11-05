"use client";
import { useParams } from "next/navigation";
import { tafqeet } from "@/lib/tafqeet";
import { Dl, OfficialSheet, phonesOf, useWho } from "@/components/official-sheet";
import { Loading, M, usePrint } from "@/components/print";
import Decimal from "decimal.js";

interface P { docNo: string | null; draftRef: string; docDate: string; supplierName: string; supplierPhones: string[] | null; supplierAddress: string | null; cashAccount: string; currency: string; exchangeRate: string; amount: string; notes: string | null; status: string; allocations: { purchaseNo: string; amount: string }[] }
export default function PrintPayment() {
  const { id } = useParams<{ id: string }>(); const { data: d, co, err } = usePrint<P>(`/api/supplier-payments/${id}`); const who = useWho();
  if (!d) return <Loading err={err} />;
  const allocated = d.allocations.reduce((s, a) => s.plus(a.amount), new Decimal(0)); const rest = new Decimal(d.amount).minus(allocated);
  return (<OfficialSheet co={co} who={who} title="سند صرف" titleEn="PAYMENT VOUCHER" pdfPath={`/print/supplier-payment/${id}`} status={d.status} leftLabel="المستلم" leftName={d.supplierName}
    boxes={<><Dl title="بيانات السند" rows={[["رقم السند", d.docNo ?? d.draftRef, true], ["التاريخ", d.docDate, true], ["صُرف من", d.cashAccount], ["العملة", d.currency === "IQD" ? "دينار عراقي (IQD)" : `${d.currency} — سعر الصرف ${Number(d.exchangeRate)}`]]} />
      <Dl title="بيانات المورد" rows={[["صُرف إلى", d.supplierName], ["الهاتف", phonesOf(d.supplierPhones), true], ["العنوان", d.supplierAddress]]} /></>}
    final={<div className="sumrow"><div><div className="words"><small>المبلغ كتابةً</small>{d.currency === "IQD" ? tafqeet(Number(d.amount)) : tafqeet(Number(d.amount), "دولار أمريكي")}</div>{d.notes && <div className="notes"><b>ملاحظات:</b> {d.notes}</div>}</div>
      <table className="sum"><tbody><tr className="net"><td>المبلغ المصروف ({d.currency})</td><td><M v={d.amount} /></td></tr>{d.allocations.length > 0 && <tr><td>المخصَّص للفواتير</td><td><M v={allocated.toString()} /></td></tr>}{rest.gt(0) && <tr className="due"><td>سلفة مورد غير مخصَّصة</td><td><M v={rest.toString()} /></td></tr>}</tbody></table></div>}>
    {d.allocations.length > 0 ? <table className="items"><thead><tr><th style={{ width: "8%" }}>#</th><th>مخصَّص لفاتورة الشراء رقم</th><th style={{ width: "30%" }}>المبلغ المخصَّص ({d.currency})</th></tr></thead>
      <tbody>{d.allocations.map((a, i) => <tr key={a.purchaseNo}><td className="c">{i + 1}</td><td className="num">{a.purchaseNo}</td><td className="e"><M v={a.amount} /></td></tr>)}</tbody></table>
      : <p style={{ margin: "14px 0", color: "#4a5568" }}>لم يُخصَّص هذا المبلغ لفاتورة شراء محددة؛ سُجّل سلفة للمورد.</p>}
  </OfficialSheet>);
}
