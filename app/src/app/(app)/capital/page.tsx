"use client";
import { useState } from "react";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, StatusBadge, useAction, useLoad } from "@/components/ui";

interface T { id: string; draftRef: string; docNo: string | null; docDate: string; kind: string; currency: string; amount: string; reason: string; status: string; requestedBy: string; approvedBy: string | null; rejectedReason: string | null }
interface Adv { id: string; draftRef: string; docNo: string | null; docDate: string; partnerName: string; partnerKind: string; kind: string; currency: string; amount: string; note: string | null; status: string }
interface Cash { id: string; name: string; currency: string; kind: string }
export default function Capital() {
  const me = useMe(); const cap = useLoad<{ balance: string; transactions: T[] }>("/api/capital", { balance: "0", transactions: [] }); const adv = useLoad<Adv[]>("/api/personal-advances", []); const cash = useLoad<Cash[]>("/api/cash-accounts", []).data.filter((c) => c.kind !== "PARTNER_CUSTODY");
  const { msg, busy, run } = useAction(() => { void cap.reload(); void adv.reload(); }); const [totp, setTotp] = useState(""); const [reason, setReason] = useState("");
  async function request(e: React.FormEvent<HTMLFormElement>) { e.preventDefault(); const f = new FormData(e.currentTarget); const c = cash.find((x) => x.id === String(f.get("cash")))!;
    await run(() => api("/api/capital", { method: "POST", body: { kind: String(f.get("kind")), docDate: String(f.get("date")), cashAccountId: c.id, currency: c.currency, amount: String(f.get("amount")), reason: String(f.get("reason")) } }), "أُرسل الطلب للاعتماد"); }
  async function draw(e: React.FormEvent<HTMLFormElement>) { e.preventDefault(); const f = new FormData(e.currentTarget); const c = cash.find((x) => x.id === String(f.get("cash")))!;
    await run(() => api("/api/personal-advances", { method: "POST", body: { partnerKind: String(f.get("who")), kind: String(f.get("kind")), docDate: today(), cashAccountId: c.id, currency: c.currency, amount: String(f.get("amount")), note: String(f.get("note") ?? "") || null } }), "حُفظ السند"); }
  return (<>
    <h1>رأس المال والسحوبات</h1>
    <div className="grid"><div className="card stat"><div className="label">رأس المال القائم</div><div className="value"><span className="num">{money(cap.data.balance)}</span></div></div></div>
    <p>المالك وحده يموّل رأس المال. كل إيداع أو سحب <strong>طلب</strong> يعتمده المالك فقط (برمز المصادقة الثنائية). السحب لا يتجاوز النقد المتاح ولا رأس المال القائم. السحب والإيداع ليسا إيراداً ولا مصروفاً.</p>
    {me.user.isOwner && <div className="card row"><div><label htmlFor="tp">رمز المصادقة الثنائية (للاعتماد)</label><input id="tp" value={totp} onChange={(e) => setTotp(e.target.value)} dir="ltr" inputMode="numeric" maxLength={6} /></div></div>}
    {can(me, "capital:create") && <form className="card row" onSubmit={request} style={{ marginTop: 12 }}>
      <div><label htmlFor="k">النوع</label><select id="k" name="kind"><option value="INJECTION">إيداع / زيادة رأس مال</option><option value="WITHDRAWAL">سحب رأس مال</option></select></div>
      <div><label htmlFor="d">التاريخ</label><input id="d" name="date" type="date" defaultValue={today()} /></div>
      <div><label htmlFor="c">الصندوق</label><select id="c" name="cash">{cash.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}</select></div>
      <div><label htmlFor="a">المبلغ</label><input id="a" name="amount" required dir="ltr" inputMode="decimal" /></div>
      <div><label htmlFor="r">السبب</label><input id="r" name="reason" required minLength={3} /></div><button className="primary" disabled={busy}>إرسال طلب</button></form>}
    <MsgBox msg={msg} />
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>النوع</th><th>المبلغ</th><th>السبب</th><th>الطالب</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{cap.data.transactions.map((t) => <tr key={t.id}><td><span className="num">{t.docNo ?? t.draftRef}</span></td><td><span className="num">{t.docDate}</span></td><td>{t.kind === "INJECTION" ? "إيداع" : "سحب"}</td><td><span className="num">{money(t.amount)} {t.currency}</span></td><td>{t.reason}</td><td>{t.requestedBy}</td>
        <td>{t.status === "REQUESTED" ? <span className="badge">بانتظار اعتماد المالك</span> : t.status === "REJECTED" ? <span className="badge">مرفوض: {t.rejectedReason}</span> : <StatusBadge s={t.status} />}</td>
        <td>{t.status === "REQUESTED" && me.user.isOwner && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/capital/${t.id}/approve`, { method: "POST", body: { totp: totp || null } }), "اعتُمد وتم الترحيل")}>اعتماد</button>}
          {t.status === "REQUESTED" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/capital/${t.id}/reject`, { method: "POST", body: { reason: reason || "مرفوض" } }), "رُفض الطلب")}>{me.user.isOwner ? "رفض" : "سحب الطلب"}</button>}</td></tr>)}
        {cap.data.transactions.length === 0 && <tr><td colSpan={8}>لا توجد حركات</td></tr>}</tbody></table></div>
    {t_hint(reason, setReason)}
    <h2>السحب الشخصي وسلف الشريك</h2>
    <p>سحب المالك → حقوق الملكية (3200). سحب الشريك → سلفة (1250) تُخصم من دفعة أرباحه. <strong>ليست مصروفاً تشغيلياً</strong>. اعتماد السند للمالك.</p>
    {can(me, "personal:create") && <form className="card row" onSubmit={draw}>
      <div><label htmlFor="w">الطرف</label><select id="w" name="who"><option value="OWNER">المالك</option><option value="PARTNER">الشريك</option></select></div>
      <div><label htmlFor="ak">النوع</label><select id="ak" name="kind"><option value="DRAW">سحب</option><option value="REPAYMENT">سداد سلفة</option></select></div>
      <div><label htmlFor="ac">الصندوق</label><select id="ac" name="cash">{cash.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}</select></div>
      <div><label htmlFor="aa">المبلغ</label><input id="aa" name="amount" required dir="ltr" inputMode="decimal" /></div><div><label htmlFor="an">ملاحظة</label><input id="an" name="note" /></div><button className="primary" disabled={busy}>حفظ</button></form>}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الرقم</th><th>الطرف</th><th>النوع</th><th>المبلغ</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{adv.data.map((a) => <tr key={a.id}><td><span className="num">{a.docNo ?? a.draftRef}</span></td><td>{a.partnerName}</td><td>{a.kind === "DRAW" ? "سحب" : "سداد"}</td><td><span className="num">{money(a.amount)} {a.currency}</span></td><td><StatusBadge s={a.status} /></td>
        <td>{a.status === "DRAFT" && me.user.isOwner && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/personal-advances/${a.id}/post`, { method: "POST" }), "تم الترحيل")}>اعتماد</button>}
          {a.status === "DRAFT" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/personal-advances/${a.id}`, { method: "DELETE" }), "حُذف")}>حذف</button>}</td></tr>)}
        {adv.data.length === 0 && <tr><td colSpan={6}>لا توجد سحوبات</td></tr>}</tbody></table></div></>);
}
function t_hint(reason: string, set: (s: string) => void) { return <div className="row" style={{ marginTop: 8 }}><div><label htmlFor="rj">سبب الرفض / سحب الطلب</label><input id="rj" value={reason} onChange={(e) => set(e.target.value)} /></div></div>; }
