"use client";
import { useState } from "react";
import { api, money } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, useAction, useLoad } from "@/components/ui";

interface C { id: string; kind: string; code: string; name: string; phones: string[] | null; paymentTermsDays: number; isArchived: boolean; version: number }
interface Stmt { supplier: { name: string }; balance: string; lines: { date: string; entryNo: string; docType: string; memo: string; debit: string; credit: string; balance: string }[] }
const KIND: Record<string, string> = { SUPPLIER: "مورد", CUSTOMER: "عميل", BOTH: "عميل ومورد" };
export default function Contacts() {
  const me = useMe(); const { data, err, reload } = useLoad<C[]>("/api/contacts?archived=1", []); const { msg, busy, run } = useAction(reload);
  const [stmt, setStmt] = useState<Stmt | null>(null);
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget), form = e.currentTarget;
    const r = await run(() => api("/api/contacts", { method: "POST", body: { kind: String(f.get("kind")), code: String(f.get("code")), name: String(f.get("name")), phones: String(f.get("phones") ?? "").split(/[,،\s]+/).filter(Boolean), paymentTermsDays: Number(f.get("terms") ?? 0) } }), "تمت الإضافة");
    if (r) form.reset();
  }
  return (<>
    <h1>العملاء والموردون</h1>
    {can(me, "contacts:create") && <form className="card row" onSubmit={create}>
      <div><label htmlFor="k">النوع</label><select id="k" name="kind"><option value="SUPPLIER">مورد</option><option value="CUSTOMER">عميل</option><option value="BOTH">عميل ومورد</option></select></div>
      <div><label htmlFor="c">الكود</label><input id="c" name="code" required dir="ltr" /></div>
      <div><label htmlFor="n">الاسم</label><input id="n" name="name" required /></div>
      <div><label htmlFor="p">الهواتف</label><input id="p" name="phones" dir="ltr" /></div>
      <div><label htmlFor="t">أيام السداد</label><input id="t" name="terms" type="number" min={0} defaultValue={0} /></div>
      <button className="primary" disabled={busy}>إضافة</button></form>}
    <MsgBox msg={msg} />{err && <div className="msg err">{err}</div>}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الكود</th><th>الاسم</th><th>النوع</th><th>أيام السداد</th><th></th></tr></thead>
      <tbody>{data.map((c) => <tr key={c.id}><td><span className="num">{c.code}</span></td><td>{c.name}</td><td>{KIND[c.kind]}</td><td><span className="num">{c.paymentTermsDays}</span></td>
        <td>{c.kind !== "CUSTOMER" && <button onClick={() => api<Stmt>(`/api/contacts/${c.id}/statement`).then(setStmt)}>كشف الحساب</button>}</td></tr>)}
        {data.length === 0 && <tr><td colSpan={5}>لا توجد جهات بعد</td></tr>}</tbody></table></div>
    {stmt && <div className="card" style={{ marginTop: 12 }}><h2>كشف حساب: {stmt.supplier.name}</h2>
      <p>الرصيد المستحق للمورد: <strong className="num">{money(stmt.balance)}</strong> IQD</p>
      <table><thead><tr><th>التاريخ</th><th>القيد</th><th>البيان</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead>
        <tbody>{stmt.lines.map((l, i) => <tr key={i}><td><span className="num">{l.date}</span></td><td><span className="num">{l.entryNo}</span></td><td>{l.memo}</td><td><span className="num">{money(l.debit)}</span></td><td><span className="num">{money(l.credit)}</span></td><td><span className="num">{money(l.balance)}</span></td></tr>)}</tbody></table></div>}
  </>);
}
