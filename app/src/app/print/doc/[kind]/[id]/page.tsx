"use client";
import { useParams } from "next/navigation";
import Decimal from "decimal.js";
import { tafqeet } from "@/lib/tafqeet";
import { Dl, OfficialSheet, phonesOf, useWho } from "@/components/official-sheet";
import { Loading, M, usePrint } from "@/components/print";

const words = (v: string, cur: string) => (cur === "IQD" ? tafqeet(Number(v)) : tafqeet(Number(v), "دولار أمريكي"));
const SETTLE: Record<string, string> = { REDUCE_RECEIVABLE: "تخفيض ذمة العميل", CASH_REFUND: "ردّ نقدي", REDUCE_PAYABLE: "تخفيض ذمة المورد" };
const MODE: Record<string, string> = { PAID_CASH: "مدفوع نقداً", ACCRUED: "مستحق (غير مدفوع)", PAID_BY_PARTNER: "دفعه الشريك" };
const TREAT: Record<string, string> = { PAYABLE_TO_PARTNER: "ذمة للشريك", OFFSET_AGAINST_ADVANCES: "تسوية موثقة مقابل السلف" };
const Total = ({ label, v }: { label: string; v: string }) => <table className="sum"><tbody><tr className="net"><td>{label}</td><td><M v={v} /></td></tr></tbody></table>;
const Words = ({ v, cur, note }: { v: string; cur: string; note?: string | null }) => <div><div className="words"><small>المبلغ كتابةً</small>{words(v, cur)}</div>{note && <div className="notes"><b>ملاحظات:</b> {note}</div>}</div>;
const Items = ({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) => <table className="items"><thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j === 0 ? "c" : undefined}>{c}</td>)}</tr>)}</tbody></table>;

export default function PrintDoc() {
  const { kind, id } = useParams<{ kind: string; id: string }>(); const { data: d, co, err } = usePrint<any>(`/api/print-docs/${kind}/${id}`); const who = useWho();
  if (!d) return <Loading err={err} />;
  const path = `/print/doc/${kind}/${id}`; const no = d.docNo ?? d.draftRef;
  const base = { co, who, pdfPath: path, status: d.status };
  if (kind === "sales-return") return (<OfficialSheet {...base} title="مرتجع مبيعات" titleEn="SALES RETURN" leftLabel="العميل" leftName={d.party}
    boxes={<><Dl title="بيانات المرتجع" rows={[["رقم المرتجع", no, true], ["التاريخ", d.docDate, true], ["الفاتورة الأصلية", d.invoiceNo, true], ["المعالجة", SETTLE[d.settlement]]]} /><Dl title="بيانات العميل" rows={[["اسم العميل", d.party], ["الهاتف", phonesOf(d.phones), true], ["السبب", d.reason]]} /></>}
    final={<div className="sumrow"><Words v={d.value} cur={d.currency} /><table className="sum"><tbody><tr className="net"><td>قيمة المرتجع ({d.currency})</td><td><M v={d.value} /></td></tr>{Number(d.applied) > 0 && <tr><td>مخصوم من ذمة العميل</td><td><M v={d.applied} /></td></tr>}{Number(d.credit) > 0 && <tr><td>رصيد دائن للعميل</td><td><M v={d.credit} /></td></tr>}{Number(d.refund) > 0 && <tr><td>مردود نقداً</td><td><M v={d.refund} /></td></tr>}</tbody></table></div>}>
    <Items head={["#", "اسم الصنف", "الوحدة", "الكمية", "القيمة"]} rows={d.lines.map((l: any, i: number) => [String(i + 1), <>{l.name}<div className="code num">{l.code}</div></>, l.uom, <M key="q" v={l.qty} />, <M key="v" v={l.value} />])} /></OfficialSheet>);
  if (kind === "purchase-return") return (<OfficialSheet {...base} title="مرتجع مشتريات" titleEn="PURCHASE RETURN" leftLabel="المورد" leftName={d.party}
    boxes={<><Dl title="بيانات المرتجع" rows={[["رقم المرتجع", no, true], ["التاريخ", d.docDate, true], ["فاتورة الشراء", d.purchaseNo, true], ["المعالجة", SETTLE[d.settlement]]]} /><Dl title="بيانات المورد" rows={[["اسم المورد", d.party], ["الهاتف", phonesOf(d.phones), true], ["السبب", d.reason]]} /></>}
    final={<div className="sumrow"><Words v={d.total} cur={d.currency} /><Total label={`قيمة المرتجع (${d.currency})`} v={d.total} /></div>}>
    <Items head={["#", "اسم الصنف", "الوحدة", "الكمية المرتجعة", "ملاحظة"]} rows={d.lines.map((l: any, i: number) => [String(i + 1), <>{l.name}<div className="code num">{l.code}</div></>, l.uom, <M key="q" v={l.qty} />, Number(l.shortage) > 0 ? `منها ${Number(l.shortage)} استثنائية: ${l.exceptionalReason ?? ""}` : ""])} /></OfficialSheet>);
  if (kind === "expense") return (<OfficialSheet {...base} title="سند مصروف" titleEn="EXPENSE VOUCHER" leftLabel="المستلم / المستفيد" wide
    boxes={<Dl title="بيانات المصروف" rows={[["رقم السند", no, true], ["التاريخ", d.docDate, true], ["التصنيف", d.category], ["البيان", d.description], ["طريقة الدفع", MODE[d.paymentMode]], ["الصندوق", d.cashAccount], ["معالجة مصروف الشريك", d.partnerTreatment ? TREAT[d.partnerTreatment] : null], ["توثيق التسوية", d.settlementNote], ["العملة", d.currency === "IQD" ? "دينار عراقي (IQD)" : `${d.currency} — سعر الصرف ${Number(d.exchangeRate)}`]]} />}
    final={<div className="sumrow"><Words v={d.amount} cur={d.currency} /><Total label={`المبلغ (${d.currency})`} v={d.amount} /></div>}><div style={{ height: 6 }} /></OfficialSheet>);
  if (kind === "stock-transfer") return (<OfficialSheet {...base} title="سند تحويل مخزني" titleEn="STOCK TRANSFER" leftLabel="المستلِم" 
    boxes={<><Dl title="بيانات السند" rows={[["رقم السند", no, true], ["التاريخ", d.docDate, true]]} /><Dl title="جهة التحويل" rows={[["من موقع", d.from], ["إلى موقع", d.to]]} /></>}
    final={d.notes ? <div className="notes"><b>ملاحظات:</b> {d.notes}</div> : null}>
    <Items head={["#", "اسم الصنف", "الوحدة", "الكمية"]} rows={d.lines.map((l: any, i: number) => [String(i + 1), <>{l.name}<div className="code num">{l.code}</div></>, l.uom, <M key="q" v={l.qty} />])} /></OfficialSheet>);
  if (kind === "capital") return (<OfficialSheet {...base} title={d.kind === "INJECTION" ? "سند إيداع رأس مال" : "سند سحب رأس مال"} titleEn={d.kind === "INJECTION" ? "CAPITAL INJECTION" : "CAPITAL WITHDRAWAL"} leftLabel="المالك (المعتمِد)" leftName={d.approvedBy ?? ""}
    boxes={<><Dl title="بيانات السند" rows={[["رقم السند", no, true], ["التاريخ", d.docDate, true], ["الصندوق", d.cashAccount], ["العملة", d.currency]]} /><Dl title="الأطراف" rows={[["الشريك", d.partner], ["الطالب", d.requestedBy], ["المعتمِد", d.approvedBy], ["السبب", d.reason], ["سبب الرفض", d.rejectedReason]]} /></>}
    final={<div className="sumrow"><Words v={d.amount} cur={d.currency} /><Total label={`المبلغ (${d.currency})`} v={d.amount} /></div>}><div style={{ height: 6 }} /></OfficialSheet>);
  const net = new Decimal(d.eligible).minus(d.deductions).plus(d.adjustments);
  return (<OfficialSheet {...base} title="كشف تسوية أرباح الشراكة" titleEn="PROFIT SETTLEMENT" leftLabel="المالك (المعتمِد)" leftName={d.approvedBy ?? ""} wide
    boxes={<Dl title="بيانات التسوية" rows={[["رقم التسوية", no, true], ["من تاريخ", d.periodStart, true], ["إلى تاريخ", d.periodEnd, true], ["ملاحظات", d.notes]]} />}
    final={<div className="sumrow"><div className="notes">القاعدة: الربح الموزَّع = الربح المرتبط بالتحصيل − المصاريف والاستقطاعات ± التسويات − الخسائر المرحَّلة؛ ثم يُقسَّم 50/50. لا ذمة على الشريك عند الخسارة (تُرحَّل).</div>
      <table className="sum"><tbody><tr><td>الربح المرتبط بالتحصيل</td><td><M v={d.eligible} /></td></tr><tr><td>المصاريف والاستقطاعات</td><td><M v={d.deductions} /></td></tr><tr><td>التسويات</td><td><M v={d.adjustments} /></td></tr>
        <tr><td>الصافي قبل الخسائر</td><td><M v={net.toString()} /></td></tr><tr><td>خسائر مرحَّلة من قبل</td><td><M v={d.lossIn} /></td></tr><tr><td>خسائر مغطّاة</td><td><M v={d.lossCovered} /></td></tr><tr><td>خسائر مرحَّلة للفترة القادمة</td><td><M v={d.lossOut} /></td></tr>
        {Number(d.reserved) > 0 && <tr><td>احتياطي محجوز</td><td><M v={d.reserved} /></td></tr>}<tr className="net"><td>القابل للتوزيع (IQD)</td><td><M v={d.distributable} /></td></tr></tbody></table></div>}><div style={{ height: 6 }} /></OfficialSheet>);
}
