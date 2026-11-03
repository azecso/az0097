"use client";
import { useState } from "react";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, StatusBadge, useAction, useLoad } from "@/components/ui";

interface Emp { id: string; name: string; jobTitle: string | null; monthlySalary: string; currency: string; isActive: boolean }
interface Acc { id: string; employee: string; month: string; currency: string; amount: string; status: string; outstanding: string }
export default function Payroll() {
  const me = useMe(); const emps = useLoad<Emp[]>("/api/employees", []); const [month, setMonth] = useState(today().slice(0, 7)); const accs = useLoad<Acc[]>(`/api/payroll?month=${month}`, []);
  const cash = useLoad<{ id: string; name: string; currency: string; kind: string }[]>("/api/cash-accounts", []).data;
  const { msg, busy, run } = useAction(() => { void emps.reload(); void accs.reload(); }); const [pay, setPay] = useState<Record<string, string>>({});
  async function addEmp(e: React.FormEvent<HTMLFormElement>) { e.preventDefault(); const f = new FormData(e.currentTarget), form = e.currentTarget;
    const r = await run(() => api("/api/employees", { method: "POST", body: { name: String(f.get("n")), jobTitle: String(f.get("j") ?? "") || null, monthlySalary: String(f.get("s")), currency: String(f.get("c")) } }), "أُضيف الموظف"); if (r) form.reset(); }
  return (<>
    <h1>الرواتب</h1>
    <p>الراتب مصروف شهري <strong>ولو لم يُدفع</strong> (مدين 6200 / دائن 2200). دفعه لاحقاً يخفض الالتزام فقط.</p>
    {can(me, "payroll:create") && <form className="card row" onSubmit={addEmp}>
      <div><label htmlFor="n">الموظف</label><input id="n" name="n" required /></div><div><label htmlFor="j">الوظيفة</label><input id="j" name="j" /></div>
      <div><label htmlFor="s">الراتب الشهري</label><input id="s" name="s" required dir="ltr" inputMode="decimal" /></div>
      <div><label htmlFor="c">العملة</label><select id="c" name="c"><option>IQD</option><option>USD</option></select></div><button className="primary" disabled={busy}>إضافة موظف</button></form>}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الموظف</th><th>الوظيفة</th><th>الراتب</th><th>الحالة</th></tr></thead>
      <tbody>{emps.data.map((e) => <tr key={e.id}><td>{e.name}</td><td>{e.jobTitle ?? "—"}</td><td><span className="num">{money(e.monthlySalary)} {e.currency}</span></td>
        <td>{can(me, "payroll:edit_draft") ? <button disabled={busy} onClick={() => run(() => api(`/api/employees/${e.id}`, { method: "PATCH", body: { isActive: !e.isActive } }), "تم التحديث")}>{e.isActive ? "نشط — إيقاف" : "موقوف — تفعيل"}</button> : e.isActive ? "نشط" : "موقوف"}</td></tr>)}
        {emps.data.length === 0 && <tr><td colSpan={4}>لا يوجد موظفون</td></tr>}</tbody></table></div>
    <h2>استحقاق الشهر</h2>
    <div className="row"><div><label htmlFor="m">الشهر</label><input id="m" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></div>
      {can(me, "payroll:create") && <button disabled={busy} onClick={() => run(() => api("/api/payroll", { method: "POST", body: { month } }), "وُلِّدت مسودات الاستحقاق (دون تكرار)")}>توليد استحقاقات الشهر</button>}</div>
    <MsgBox msg={msg} />
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الموظف</th><th>الراتب</th><th>المتبقي</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{accs.data.map((a) => <tr key={a.id}><td>{a.employee}</td><td><span className="num">{money(a.amount)} {a.currency}</span></td><td><span className="num">{money(a.outstanding)}</span></td><td><StatusBadge s={a.status} /></td>
        <td>{a.status === "DRAFT" && can(me, "payroll:approve") && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/payroll/${a.id}/post`, { method: "POST" }), "تم ترحيل الاستحقاق")}>ترحيل الاستحقاق</button>}
          {a.status === "DRAFT" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/payroll/${a.id}`, { method: "DELETE" }), "حُذف")}>حذف</button>}
          {a.status === "POSTED" && Number(a.outstanding) > 0 && can(me, "payroll:approve") && <><input aria-label="المبلغ" placeholder="المبلغ" style={{ maxWidth: 120 }} dir="ltr" value={pay[a.id] ?? a.outstanding} onChange={(e) => setPay({ ...pay, [a.id]: e.target.value })} />
            <button disabled={busy} onClick={() => run(() => api("/api/payroll-payments", { method: "POST", body: { accrualId: a.id, docDate: today(), cashAccountId: cash.find((c) => c.currency === a.currency && c.kind === "MAIN_CASH")?.id, amount: pay[a.id] ?? a.outstanding } }), "تم دفع الراتب")}>دفع</button></>}</td></tr>)}
        {accs.data.length === 0 && <tr><td colSpan={5}>لا توجد استحقاقات لهذا الشهر</td></tr>}</tbody></table></div></>);
}
