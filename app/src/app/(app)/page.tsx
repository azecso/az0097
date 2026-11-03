"use client";
import { useMe } from "@/components/me";

// Phase 1: the financial dashboard needs the ledger (Phases 2–4). We deliberately show NO placeholder
// numbers: a financial screen must never display values that are not real.
const CARDS = ["رأس المال", "رصيد الصندوق", "قيمة المخزون", "ديون العملاء", "ديون الموردين", "الربح القابل للتوزيع"];
export default function Dashboard() {
  const me = useMe();
  return (<>
    <h1>لوحة التحكم المالية</h1>
    <p>مرحباً {me.user.displayName}. الأساس جاهز: الدخول والصلاحيات والعملات وسجل التدقيق. الأرقام المالية تظهر بعد تفعيل المخزون والمبيعات والدفتر في المراحل التالية.</p>
    <div className="grid">{CARDS.map((c) => (<div className="card stat" key={c}><div className="label">{c}</div><div className="value"><span className="num">—</span></div><span className="badge">غير مفعّل بعد</span></div>))}</div>
  </>);
}
