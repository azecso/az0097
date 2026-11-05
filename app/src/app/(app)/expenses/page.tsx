"use client";
import { useState } from "react";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { createDraft, useRefList } from "@/lib/offline/use";
import { PickOrCreate } from "@/components/pick";
import { MsgBox, StatusBadge, useAction, useLoad , ReverseBox, PrintLink } from "@/components/ui";

interface E { id: string; draftRef: string; docNo: string | null; docDate: string; category: string; description: string; currency: string; amount: string; paymentMode: string; partnerTreatment: string | null; status: string; outstanding: string }
interface Cat { id: string; name: string } interface Cash { id: string; name: string; currency: string; kind: string }
const MODE: Record<string, string> = { PAID_CASH: "مدفوع نقداً", ACCRUED: "مستحق (آجل)", PAID_BY_PARTNER: "دفعه الشريك" };
export default function Expenses() {
  const me = useMe(); const list = useLoad<E[]>("/api/expenses", []); const cats = useRefList<Cat>("expenseCategories", "/api/expense-categories").data; const cash = useRefList<Cash>("cashAccounts", "/api/cash-accounts").data;
  const { msg, busy, run, setMsg } = useAction(list.reload); const [mode, setMode] = useState("PAID_CASH"); const [cur, setCur] = useState("IQD"); const [treat, setTreat] = useState("PAYABLE_TO_PARTNER"); const [reason, setReason] = useState(""); const [pay, setPay] = useState<Record<string, string>>({});
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const r = await run(() => createDraft({ entityType: "expense", endpoint: "/api/expenses", title: "مصروف (أوفلاين)", payload: { docDate: String(f.get("date")), categoryId: String(f.get("cat")), description: String(f.get("desc")), currency: cur, exchangeRate: cur === "USD" ? String(f.get("rate") || "") || null : null, amount: String(f.get("amount")), paymentMode: mode,
      cashAccountId: mode === "PAID_CASH" ? String(f.get("cash")) : null, partnerTreatment: mode === "PAID_BY_PARTNER" ? treat : null, settlementNote: mode === "PAID_BY_PARTNER" && treat === "OFFSET_AGAINST_ADVANCES" ? String(f.get("note")) : null } }), "حُفظت المسودة");
    if (r?.mode === "queued") setMsg({ t: "ok", m: "📴 حُفظت على جهازك مشفّرة وبانتظار المزامنة — ستُرسل تلقائياً عند عودة الاتصال (تابعها من «المزامنة»)." });
  }
  const mainCash = cash.filter((c) => c.kind !== "PARTNER_CUSTODY");
  return (<>
    <h1>المصاريف</h1>
    <p>المصروف يُسجَّل <strong>مرة واحدة</strong> عند الترحيل. السداد اللاحق للمصروف المستحق أو لذمة الشريك يخفض الالتزام والنقد فقط ولا يُنشئ مصروفاً جديداً.</p>
    {can(me, "expense:create") && <form className="card" onSubmit={create} style={{ display: "grid", gap: 12 }}>
      <div className="row">
        <div><label htmlFor="d">التاريخ</label><input id="d" name="date" type="date" defaultValue={today()} /></div>
        <div><label htmlFor="c">التصنيف</label><PickOrCreate kind="category" id="c" name="cat" required options={cats.map((c) => ({ id: c.id, label: c.name }))} /></div>
        <div><label htmlFor="de">البيان</label><input id="de" name="desc" required minLength={2} /></div>
        <div><label htmlFor="cu">العملة</label><select id="cu" value={cur} onChange={(e) => setCur(e.target.value)}><option>IQD</option><option>USD</option></select></div>
        {cur === "USD" && <div><label htmlFor="r">سعر الصرف</label><input id="r" name="rate" dir="ltr" inputMode="decimal" /></div>}
        <div><label htmlFor="a">المبلغ</label><input id="a" name="amount" required dir="ltr" inputMode="decimal" /></div></div>
      <div className="row">
        <div><label htmlFor="m">طريقة الدفع</label><select id="m" value={mode} onChange={(e) => setMode(e.target.value)}>{Object.entries(MODE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        {mode === "PAID_CASH" && <div><label htmlFor="ca">من صندوق</label><select id="ca" name="cash">{mainCash.filter((c) => c.currency === cur).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
        {mode === "PAID_BY_PARTNER" && <><div><label htmlFor="t">معالجة مصروف الشريك (واحدة فقط)</label><select id="t" value={treat} onChange={(e) => setTreat(e.target.value)}><option value="PAYABLE_TO_PARTNER">ذمة واجبة السداد للشريك</option><option value="OFFSET_AGAINST_ADVANCES">تسوية موثقة مقابل سلف الشريك</option></select></div>
          {treat === "OFFSET_AGAINST_ADVANCES" && <div><label htmlFor="n">توثيق التسوية (إلزامي)</label><input id="n" name="note" required minLength={5} /></div>}</>}
      </div>
      <MsgBox msg={msg} /><button className="primary" disabled={busy}>حفظ كمسودة</button></form>}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>التصنيف</th><th>البيان</th><th>المبلغ</th><th>الدفع</th><th>المستحق</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{list.data.map((x) => <tr key={x.id}><td><span className="num">{x.docNo ?? x.draftRef}</span></td><td><span className="num">{x.docDate}</span></td><td>{x.category}</td><td>{x.description}</td><td><span className="num">{money(x.amount)} {x.currency}</span></td>
        <td>{MODE[x.paymentMode]}{x.partnerTreatment === "OFFSET_AGAINST_ADVANCES" ? " (تسوية)" : ""}</td><td><span className="num">{money(x.outstanding)}</span></td><td><StatusBadge s={x.status} /></td>
        <td><PrintLink path={`/print/doc/expense/${x.id}`} />{x.status === "DRAFT" && can(me, "expense:approve") && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/expenses/${x.id}/post`, { method: "POST" }), "تم الترحيل")}>ترحيل</button>}
          {x.status === "DRAFT" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/expenses/${x.id}`, { method: "DELETE" }), "حُذفت المسودة")}>حذف</button>}
          {x.status === "POSTED" && Number(x.outstanding) > 0 && can(me, "expense:approve") && <><input aria-label="مبلغ السداد" placeholder="مبلغ السداد" style={{ maxWidth: 120 }} dir="ltr" value={pay[x.id] ?? ""} onChange={(e) => setPay({ ...pay, [x.id]: e.target.value })} />
            <button disabled={busy || !pay[x.id]} onClick={() => run(() => api("/api/expense-payments", { method: "POST", body: { expenseId: x.id, docDate: today(), cashAccountId: mainCash.find((c) => c.currency === x.currency)?.id, amount: pay[x.id] } }), "تم السداد")}>سداد</button></>}
          {x.status === "POSTED" && can(me, "expense:cancel") && <ReverseBox busy={busy} onReverse={(reason) => run(() => api(`/api/expenses/${x.id}/reverse`, { method: "POST", body: { reason } }), "تم العكس")} />}</td></tr>)}
        {list.data.length === 0 && <tr><td colSpan={9}>لا توجد مصاريف</td></tr>}</tbody></table></div></>);
}
