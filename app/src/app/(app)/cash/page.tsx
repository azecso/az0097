"use client";
import { useState } from "react";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, StatusBadge, useAction, useLoad } from "@/components/ui";

interface A { id: string; name: string; currency: string; kind: string; countsTowardAvailable: boolean; balance: string }
interface T { id: string; draftRef: string; docNo: string | null; docDate: string; from: string; to: string; currency: string; amount: string; status: string }
const KIND: Record<string, string> = { MAIN_CASH: "صندوق رئيسي", BANK: "حساب مصرفي", PARTNER_CUSTODY: "عهدة الشريك (ذمة)", TRANSITIONAL: "انتقالي" };
export default function Cash() {
  const me = useMe(); const acc = useLoad<A[]>("/api/cash-accounts", []); const list = useLoad<T[]>("/api/cash-transfers", []);
  const { msg, busy, run } = useAction(() => { void acc.reload(); void list.reload(); }); const [reason, setReason] = useState("");
  async function create(e: React.FormEvent<HTMLFormElement>) { e.preventDefault(); const f = new FormData(e.currentTarget);
    await run(() => api("/api/cash-transfers", { method: "POST", body: { docDate: String(f.get("date")), fromAccountId: String(f.get("from")), toAccountId: String(f.get("to")), amount: String(f.get("amount")), notes: String(f.get("notes") ?? "") || null } }), "حُفظ السند"); }
  return (<><h1>النقدية والعهدة</h1>
    <div className="grid">{acc.data.map((a) => <div className="card stat" key={a.id}><div className="label">{a.name} — {KIND[a.kind]}</div><div className="value"><span className="num">{money(a.balance)}</span> <small>{a.currency}</small></div>
      {!a.countsTowardAvailable && <span className="badge">لا تُحتسب ضمن النقد المتاح</span>}</div>)}</div>
    {can(me, "voucher:create") && <form className="card row" onSubmit={create} style={{ marginTop: 12 }}>
      <div><label htmlFor="f">من</label><select id="f" name="from">{acc.data.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
      <div><label htmlFor="t">إلى</label><select id="t" name="to">{acc.data.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
      <div><label htmlFor="a">المبلغ</label><input id="a" name="amount" required dir="ltr" inputMode="decimal" /></div>
      <div><label htmlFor="d">التاريخ</label><input id="d" name="date" type="date" defaultValue={today()} /></div>
      <div><label htmlFor="n">ملاحظة</label><input id="n" name="notes" /></div><button className="primary" disabled={busy}>سند تحويل / تسليم عهدة</button></form>}
    <MsgBox msg={msg} />
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>من</th><th>إلى</th><th>المبلغ</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{list.data.map((t) => <tr key={t.id}><td><span className="num">{t.docNo ?? t.draftRef}</span></td><td><span className="num">{t.docDate}</span></td><td>{t.from}</td><td>{t.to}</td><td><span className="num">{money(t.amount)} {t.currency}</span></td><td><StatusBadge s={t.status} /></td>
        <td><a href={`/print/cash-transfer/${t.id}`} target="_blank" rel="noreferrer"><button>طباعة</button></a>{t.status === "DRAFT" && can(me, "voucher:approve") && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/cash-transfers/${t.id}/post`, { method: "POST" }), "تم الترحيل")}>ترحيل</button>}
          {t.status === "DRAFT" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/cash-transfers/${t.id}`, { method: "DELETE" }), "حُذف")}>حذف</button>}
          {t.status === "POSTED" && can(me, "voucher:cancel") && <><input aria-label="سبب العكس" placeholder="سبب العكس" style={{ maxWidth: 160 }} value={reason} onChange={(e) => setReason(e.target.value)} /><button className="danger" disabled={busy || reason.length < 3} onClick={() => run(() => api(`/api/cash-transfers/${t.id}/reverse`, { method: "POST", body: { reason } }), "تم العكس")}>عكس</button></>}</td></tr>)}
        {list.data.length === 0 && <tr><td colSpan={7}>لا توجد سندات تحويل</td></tr>}</tbody></table></div></>);
}
