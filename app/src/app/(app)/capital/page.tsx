"use client";
import { useState } from "react";
import Decimal from "decimal.js";
import Link from "next/link";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, StatusBadge, useAction, useLoad, PrintLink, ReverseBox } from "@/components/ui";
import { Modal } from "@/components/modal";

interface T { id: string; draftRef: string; docNo: string | null; docDate: string; kind: string; currency: string; amount: string; reason: string; status: string; requestedBy: string; approvedBy: string | null; rejectedReason: string | null }
interface Adv { id: string; draftRef: string; docNo: string | null; docDate: string; partnerName: string; partnerKind: string; kind: string; currency: string; amount: string; note: string | null; status: string }
interface Cash { id: string; name: string; currency: string; kind: string }
interface DebtPay { id: string; payDate: string; amount: string; note: string | null; status: string }
interface Debt { id: string; docNo: string | null; docDate: string; person: string; currency: string; amount: string; paid: string; remaining: string; note: string | null; status: string; state: string; payments: DebtPay[] }
interface DebtTot { person: string; currency: string; debts: string; paid: string; remaining: string }
const DSTATE: Record<string, string> = { OPEN: "قائم", PARTIAL: "مسدَّد جزئياً", PAID: "مسدَّد", REVERSED: "ملغى" };
export default function Capital() {
  const me = useMe(); const cap = useLoad<{ balance: string; transactions: T[] }>("/api/capital", { balance: "0", transactions: [] }); const adv = useLoad<Adv[]>("/api/personal-advances", []); const cash = useLoad<Cash[]>("/api/cash-accounts", []).data.filter((c) => c.kind !== "PARTNER_CUSTODY");
  const debts = useLoad<{ rows: Debt[]; totals: DebtTot[] }>("/api/personal-debts", { rows: [], totals: [] });
  const { msg, busy, run } = useAction(() => { void cap.reload(); void adv.reload(); void debts.reload(); });
  const [method, setMethod] = useState<"CASH" | "DEBT">("CASH"); const [whoSel, setWhoSel] = useState("OWNER"); const [debtRid, setDebtRid] = useState(() => `debt-${crypto.randomUUID()}`); const [payFor, setPayFor] = useState<Debt | null>(null); const [payRid, setPayRid] = useState(() => `dpay-${crypto.randomUUID()}`); const [totp, setTotp] = useState(""); const [reason, setReason] = useState("");
  async function request(e: React.FormEvent<HTMLFormElement>) { e.preventDefault(); const f = new FormData(e.currentTarget); const c = cash.find((x) => x.id === String(f.get("cash")))!;
    await run(() => api("/api/capital", { method: "POST", body: { kind: String(f.get("kind")), docDate: String(f.get("date")), cashAccountId: c.id, currency: c.currency, amount: String(f.get("amount")), reason: String(f.get("reason")) } }), "أُرسل الطلب للاعتماد"); }
  async function addDebt(e: React.FormEvent<HTMLFormElement>) { e.preventDefault(); const form = e.currentTarget; const f = new FormData(form);
    const r = await run(() => api("/api/personal-debts", { method: "POST", body: { requestId: debtRid, partnerKind: whoSel === "OWNER" || whoSel === "PARTNER" ? whoSel : null, person: whoSel === "OTHER" ? String(f.get("person") ?? "") : null, docDate: String(f.get("date")), currency: String(f.get("cur")), amount: String(f.get("amount")), note: String(f.get("note") ?? "") || null } }), "سُجّل الدين الشخصي — لم يتأثر الصندوق");
    if (r !== undefined) { setDebtRid(`debt-${crypto.randomUUID()}`); form.reset(); } }
  async function draw(e: React.FormEvent<HTMLFormElement>) { if (method === "DEBT") return addDebt(e); e.preventDefault(); const f = new FormData(e.currentTarget); const c = cash.find((x) => x.id === String(f.get("cash")))!;
    await run(() => api("/api/personal-advances", { method: "POST", body: { partnerKind: String(f.get("who")), kind: String(f.get("kind")), docDate: today(), cashAccountId: c.id, currency: c.currency, amount: String(f.get("amount")), note: String(f.get("note") ?? "") || null } }), "حُفظ السند"); }
  return (<>
    <h1>رأس المال والسحوبات</h1>
    <div className="grid"><div className="card stat"><div className="label">رأس المال القائم</div><div className="value"><span className="num">{money(cap.data.balance)}</span></div></div>
      <div className="card stat"><div className="label">إجمالي الإيداعات المعتمدة</div><div className="value"><span className="num">{money(cap.data.transactions.filter((t) => t.status === "POSTED" && t.kind === "INJECTION").reduce((x, t) => x.plus(t.amount), new Decimal(0)).toString())}</span></div></div>
      <div className="card stat"><div className="label">إجمالي السحوبات المعتمدة</div><div className="value"><span className="num">{money(cap.data.transactions.filter((t) => t.status === "POSTED" && t.kind === "WITHDRAWAL").reduce((x, t) => x.plus(t.amount), new Decimal(0)).toString())}</span></div></div></div>
    <p>المصدر: كل إيداع في الجدول أدناه بتاريخه ورقمه ومن طلبه ومن اعتمده. <Link href="/capital/returns">سجل إرجاع رأس المال ←</Link></p>
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
        <td><PrintLink path={`/print/doc/capital/${t.id}`} />{t.status === "REQUESTED" && me.user.isOwner && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/capital/${t.id}/approve`, { method: "POST", body: { totp: totp || null } }), "اعتُمد وتم الترحيل")}>اعتماد</button>}
          {t.status === "REQUESTED" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/capital/${t.id}/reject`, { method: "POST", body: { reason: reason || "مرفوض" } }), "رُفض الطلب")}>{me.user.isOwner ? "رفض" : "سحب الطلب"}</button>}</td></tr>)}
        {cap.data.transactions.length === 0 && <tr><td colSpan={8}>لا توجد حركات</td></tr>}</tbody></table></div>
    {t_hint(reason, setReason)}
    <h2>السحب الشخصي وسلف الشريك</h2>
    <p>سحب المالك → حقوق الملكية (3200). سحب الشريك → سلفة (1250) تُخصم من دفعة أرباحه. <strong>ليست مصروفاً تشغيلياً</strong>. اعتماد السند للمالك.</p>
    {can(me, "personal:create") && <form className="card row" onSubmit={draw}>
      <div><label htmlFor="am">طريقة السحب</label><select id="am" value={method} onChange={(e) => { const m = e.target.value as "CASH" | "DEBT"; setMethod(m); if (m === "CASH" && whoSel === "OTHER") setWhoSel("OWNER"); }}><option value="CASH">من الصندوق</option><option value="DEBT">دين شخصي (خارج الصندوق)</option></select></div>
      <div><label htmlFor="w">الطرف</label><select id="w" name="who" value={whoSel} onChange={(e) => setWhoSel(e.target.value)}><option value="OWNER">المالك</option><option value="PARTNER">الشريك</option>{method === "DEBT" && <option value="OTHER">شخص آخر (اكتب الاسم)…</option>}</select></div>
      {method === "DEBT" && whoSel === "OTHER" && <div><label htmlFor="ap">اسم الشخص</label><input id="ap" name="person" required minLength={2} /></div>}
      {method === "CASH" && <div><label htmlFor="ak">النوع</label><select id="ak" name="kind"><option value="DRAW">سحب</option><option value="REPAYMENT">سداد سلفة</option></select></div>}
      {method === "CASH" ? <div><label htmlFor="ac">الصندوق</label><select id="ac" name="cash">{cash.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}</select></div>
        : <><div><label htmlFor="ad">التاريخ</label><input id="ad" name="date" type="date" defaultValue={today()} required /></div><div><label htmlFor="ar">العملة</label><select id="ar" name="cur"><option value="IQD">IQD</option><option value="USD">USD</option></select></div></>}
      <div><label htmlFor="aa">المبلغ</label><input id="aa" name="amount" required dir="ltr" inputMode="decimal" /></div><div><label htmlFor="an">ملاحظة</label><input id="an" name="note" /></div><button className="primary" disabled={busy}>حفظ</button></form>}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الرقم</th><th>الطرف</th><th>النوع</th><th>المبلغ</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{adv.data.map((a) => <tr key={a.id}><td><span className="num">{a.docNo ?? a.draftRef}</span></td><td>{a.partnerName}</td><td>{a.kind === "DRAW" ? "سحب" : "سداد"}</td><td><span className="num">{money(a.amount)} {a.currency}</span></td><td><StatusBadge s={a.status} /></td>
        <td>{a.status === "DRAFT" && me.user.isOwner && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/personal-advances/${a.id}/post`, { method: "POST" }), "تم الترحيل")}>اعتماد</button>}
          {a.status === "DRAFT" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/personal-advances/${a.id}`, { method: "DELETE" }), "حُذف")}>حذف</button>}</td></tr>)}
        {adv.data.length === 0 && <tr><td colSpan={6}>لا توجد سحوبات</td></tr>}</tbody></table></div>
    <h2 style={{ marginTop: 24 }}>صندوق الدين الشخصي</h2>
    <p>توثيق فقط: مبلغ استلفه شخص وبقي بذمته. <strong>لا يخرج من الصندوق ولا يتأثر به رصيد الصندوق أو الأرباح</strong>، والتسديد أيضاً خارج الصندوق ولا يدخل نقداً.</p>
    {debts.data.totals.length > 0 && <div className="card row">{debts.data.totals.map((t) => <div key={t.person + t.currency}><b>{t.person}</b>: الباقي في ذمته <b className="num">{money(t.remaining)} {t.currency}</b> <small>(من {money(t.debts)}، مسدَّد {money(t.paid)})</small></div>)}</div>}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>الشخص</th><th>المبلغ</th><th>المسدَّد</th><th>الباقي</th><th>الملاحظة</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{debts.data.rows.map((g) => <><tr key={g.id}><td><span className="num">{g.docNo ?? "—"}</span></td><td><span className="num">{g.docDate}</span></td><td>{g.person}</td><td><span className="num">{money(g.amount)} {g.currency}</span></td><td><span className="num">{money(g.paid)}</span></td><td><b className="num">{money(g.remaining)}</b></td><td>{g.note ?? ""}</td><td>{DSTATE[g.state]}</td>
        <td>{g.status === "ACTIVE" && can(me, "personal:create") && Number(g.remaining) > 0 && <button type="button" onClick={() => { setPayFor(g); setPayRid(`dpay-${crypto.randomUUID()}`); }}>تسديد</button>}
          {g.status === "ACTIVE" && can(me, "personal:cancel") && <ReverseBox label="إلغاء" busy={busy} onReverse={(why) => run(() => api(`/api/personal-debts/${g.id}/reverse`, { method: "POST", body: { reason: why } }), "أُلغي الدين")} />}</td></tr>
        {g.payments.map((p) => <tr key={p.id} style={{ opacity: p.status === "ACTIVE" ? 1 : 0.5 }}><td></td><td><span className="num">{p.payDate}</span></td><td colSpan={2}>↳ تسديد (خارج الصندوق){p.status !== "ACTIVE" ? " — ملغى" : ""}</td><td><span className="num">{money(p.amount)}</span></td><td colSpan={3}>{p.note ?? ""}</td><td></td>
          <td>{p.status === "ACTIVE" && can(me, "personal:cancel") && <ReverseBox label="إلغاء" busy={busy} onReverse={(why) => run(() => api(`/api/personal-debt-payments/${p.id}/reverse`, { method: "POST", body: { reason: why } }), "أُلغي التسديد")} />}</td></tr>)}</>)}
        {debts.data.rows.length === 0 && <tr><td colSpan={9}>لا توجد ديون شخصية</td></tr>}</tbody></table></div>
    {payFor && <Modal title={`تسديد دين ${payFor.person}`} onClose={() => setPayFor(null)}>
      <p>الباقي: <b className="num">{money(payFor.remaining)} {payFor.currency}</b>. التسديد يُوثَّق فقط ولا يدخل الصندوق.</p>
      <form onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const r = await run(() => api(`/api/personal-debts/${payFor.id}/pay`, { method: "POST", body: { requestId: payRid, payDate: String(f.get("pd")), amount: String(f.get("pa")), note: String(f.get("pn") ?? "") || null } }), "سُجّل التسديد"); if (r !== undefined) setPayFor(null); }} style={{ display: "grid", gap: 10 }}>
        <div><label htmlFor="pa">المبلغ</label><input id="pa" name="pa" inputMode="decimal" dir="ltr" required defaultValue={String(Number(payFor.remaining))} /></div>
        <div><label htmlFor="pd">التاريخ</label><input id="pd" name="pd" type="date" defaultValue={today()} required /></div>
        <div><label htmlFor="pn">ملاحظة</label><input id="pn" name="pn" /></div>
        <button className="primary" disabled={busy}>حفظ التسديد</button></form></Modal>}</>);
}
function t_hint(reason: string, set: (s: string) => void) { return <div className="row" style={{ marginTop: 8 }}><div><label htmlFor="rj">سبب الرفض / سحب الطلب</label><input id="rj" value={reason} onChange={(e) => set(e.target.value)} /></div></div>; }
