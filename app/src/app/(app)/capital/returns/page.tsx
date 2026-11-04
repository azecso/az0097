"use client";
import { useState } from "react";
import Link from "next/link";
import { api, money } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, useAction, useLoad } from "@/components/ui";

interface R { id: string; docNo: string; returnedAt: string; currency: string; amount: string; recipientName: string; refNo: string | null; method: string; note: string | null; version: number; createdBy: string }
interface Data { rows: R[]; totals: { currency: string; total: string; n: number }[] }
const METHODS: Record<string, string> = { CASH: "نقداً", TRANSFER: "حوالة", CHEQUE: "صك", OTHER: "أخرى" };
const localInput = (iso?: string) => { const d = iso ? new Date(iso) : new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const show = (iso: string) => new Date(iso).toLocaleString("en-GB", { hour12: false }).replace(",", "");

export default function CapitalReturns() {
  const me = useMe(); const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [q, setQ] = useState(""); const [edit, setEdit] = useState<R | null>(null);
  const qs = new URLSearchParams(Object.entries({ from, to, q }).filter(([, v]) => v)).toString();
  const list = useLoad<Data>(`/api/capital-returns${qs ? `?${qs}` : ""}`, { rows: [], totals: [] });
  const { msg, busy, run } = useAction(() => { void list.reload(); setEdit(null); });
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const body = { returnedAt: new Date(String(f.get("at"))).toISOString(), currency: String(f.get("cur")), amount: String(f.get("amount")), recipientName: String(f.get("who")), refNo: String(f.get("ref") || "") || null, method: String(f.get("method")), note: String(f.get("note") || "") || null };
    const ok = await run(() => edit ? api(`/api/capital-returns/${edit.id}`, { method: "PUT", body: { ...body, version: edit.version } }) : api("/api/capital-returns", { method: "POST", body }), edit ? "تم حفظ التعديل" : "تم تسجيل الإرجاع");
    if (ok !== undefined) (e.target as HTMLFormElement).reset();
  }
  async function del(r: R) { const reason = window.prompt(`سبب حذف ${r.docNo}؟ (يُحفظ في سجل التدقيق)`); if (!reason || reason.trim().length < 3) return; await run(() => api(`/api/capital-returns/${r.id}?reason=${encodeURIComponent(reason.trim())}`, { method: "DELETE" }), "تم الحذف"); }
  return (<>
    <h1>إرجاع رأس المال</h1>
    <p>سجل <strong>معلوماتي</strong> لما سُدِّد من رأس المال إلى صاحبه (الوقت والمبلغ والمستلم ورقم الوصل). <strong>لا يؤثر على الحسابات الداخلية ولا على الصندوق.</strong> يمكن تعديل أي سجل أو حذفه عند الخطأ، ويُحفظ كل تغيير في سجل التدقيق.</p>
    <div className="grid">{list.data.totals.length === 0 ? <div className="card stat"><div className="label">إجمالي المُرجَع</div><div className="value">0</div></div> :
      list.data.totals.map((t) => <div key={t.currency} className="card stat"><div className="label">إجمالي المُرجَع ({t.currency}) — {t.n} سجل</div><div className="value"><span className="num">{money(t.total)}</span></div></div>)}</div>
    {(can(me, "capital:create") || (edit && can(me, "capital:edit_draft"))) && <form key={edit?.id ?? "new"} className="card row" onSubmit={save} style={{ marginTop: 12 }}>
      <div><label htmlFor="at">التاريخ والوقت</label><input id="at" name="at" type="datetime-local" defaultValue={localInput(edit?.returnedAt)} required /></div>
      <div><label htmlFor="cur">العملة</label><select id="cur" name="cur" defaultValue={edit?.currency ?? "IQD"}><option>IQD</option><option>USD</option></select></div>
      <div><label htmlFor="amount">المبلغ</label><input id="amount" name="amount" defaultValue={edit?.amount ? String(Number(edit.amount)) : ""} required dir="ltr" inputMode="decimal" /></div>
      <div><label htmlFor="who">اسم المستلم</label><input id="who" name="who" defaultValue={edit?.recipientName} required minLength={2} /></div>
      <div><label htmlFor="ref">رقم الوصل / الفاتورة</label><input id="ref" name="ref" defaultValue={edit?.refNo ?? ""} dir="ltr" /></div>
      <div><label htmlFor="method">طريقة التسليم</label><select id="method" name="method" defaultValue={edit?.method ?? "CASH"}>{Object.entries(METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
      <div><label htmlFor="note">ملاحظات</label><input id="note" name="note" defaultValue={edit?.note ?? ""} /></div>
      <button className="primary" disabled={busy}>{edit ? "حفظ التعديل" : "تسجيل إرجاع"}</button>{edit && <button type="button" onClick={() => setEdit(null)}>إلغاء التعديل</button>}</form>}
    <MsgBox msg={msg} />
    <div className="card row" style={{ marginTop: 12 }}>
      <div><label htmlFor="f">من تاريخ</label><input id="f" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
      <div><label htmlFor="t">إلى تاريخ</label><input id="t" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      <div><label htmlFor="s">بحث (مستلم / رقم)</label><input id="s" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الرقم</th><th>التاريخ والوقت</th><th>المستلم</th><th>المبلغ</th><th>رقم الوصل</th><th>الطريقة</th><th>ملاحظات</th><th>سجّله</th><th></th></tr></thead>
      <tbody>{list.data.rows.map((r) => <tr key={r.id}><td><span className="num">{r.docNo}</span></td><td><span className="num">{show(r.returnedAt)}</span></td><td>{r.recipientName}</td><td><span className="num">{money(r.amount)}</span> {r.currency}</td><td><span className="num">{r.refNo ?? ""}</span></td><td>{METHODS[r.method]}</td><td>{r.note}</td><td>{r.createdBy}</td>
        <td><Link href={`/print/capital-return/${r.id}`} target="_blank">طباعة</Link>{can(me, "capital:edit_draft") && <> · <button type="button" onClick={() => { setEdit(r); window.scrollTo(0, 0); }}>تعديل</button> · <button type="button" onClick={() => del(r)}>حذف</button></>}</td></tr>)}
        {list.data.rows.length === 0 && <tr><td colSpan={9}>لا توجد سجلات</td></tr>}</tbody></table></div>
  </>);
}
