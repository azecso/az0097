"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { money } from "@/lib/client";
import { MsgBox, useLoad } from "@/components/ui";

interface Acc { id: string; name: string; currency: string; balance: string }
interface Row { id: string; movedAt: string; account: string; currency: string; amount: string; balance: string; source: string; docType: string; docId: string; docNo: string | null; party: string | null; note: string | null }
const DOC_LINK: Record<string, string> = { customer_receipt: "/sales/receipts", purchase_order: "/purchases", capital: "/capital", cash_transfer: "/cash", expense: "/expenses", supplier_payment: "/purchases/payments", sales_return: "/sales/returns" };
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { hour12: false }).replace(",", "");

function Inner() {
  const sp = useSearchParams(); const [acc, setAcc] = useState(sp.get("account") ?? ""); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const accounts = useLoad<Acc[]>("/api/cash-accounts", []).data;
  const qs = new URLSearchParams(Object.entries({ accountId: acc, from, to }).filter(([, v]) => v)).toString();
  const res = useLoad<{ rows: Row[]; bySource: { source: string; currency: string; in: string; out: string }[]; truncated: boolean }>(`/api/cash-ledger${qs ? `?${qs}` : ""}`, { rows: [], bySource: [], truncated: false });
  return (<>
    <h1>حركة الصندوق — من أين أتى المبلغ وأين ذهب</h1>
    <div className="grid">{accounts.map((a) => <div className="card stat" key={a.id}><div className="label">{a.name}</div><div className="value"><span className="num">{money(a.balance)}</span> <small>{a.currency}</small></div></div>)}</div>
    <div className="card row" style={{ marginTop: 12 }}>
      <div><label htmlFor="a">الحساب</label><select id="a" value={acc} onChange={(e) => setAcc(e.target.value)}><option value="">كل الحسابات</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}</select></div>
      <div><label htmlFor="f">من تاريخ</label><input id="f" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
      <div><label htmlFor="t">إلى تاريخ</label><input id="t" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
    </div>
    <MsgBox msg={res.err ? { t: "err", m: res.err } : null} />
    <div className="card cards-as-list" style={{ marginTop: 12 }}><h2>ملخص حسب المصدر</h2><table><thead><tr><th>المصدر</th><th>العملة</th><th>الداخل</th><th>الخارج</th></tr></thead>
      <tbody>{res.data.bySource.map((s) => <tr key={s.source + s.currency}><td>{s.source}</td><td>{s.currency}</td><td><span className="num">{money(s.in)}</span></td><td><span className="num">{money(s.out)}</span></td></tr>)}
        {res.data.bySource.length === 0 && <tr><td colSpan={4}>لا توجد حركات</td></tr>}</tbody></table></div>
    <div className="card cards-as-list" style={{ marginTop: 12 }}><h2>التفاصيل</h2><table><thead><tr><th>التاريخ والوقت</th><th>الحساب</th><th>المصدر</th><th>رقم المستند</th><th>الجهة</th><th>الداخل</th><th>الخارج</th><th>الرصيد بعدها</th></tr></thead>
      <tbody>{res.data.rows.map((r) => { const a = Number(r.amount); return <tr key={r.id}><td><span className="num">{when(r.movedAt)}</span></td><td>{r.account}</td><td>{r.source}{r.note ? <small> — {r.note}</small> : null}</td>
        <td>{r.docNo ? (DOC_LINK[r.docType] ? <Link href={DOC_LINK[r.docType]!}><span className="num">{r.docNo}</span></Link> : <span className="num">{r.docNo}</span>) : "—"}</td><td>{r.party ?? "—"}</td>
        <td>{a > 0 && <span className="num" style={{ color: "var(--ok, #176b2c)" }}>{money(r.amount)} {r.currency}</span>}</td><td>{a < 0 && <span className="num" style={{ color: "var(--danger)" }}>{money(r.amount.replace("-", ""))} {r.currency}</span>}</td><td><span className="num">{money(r.balance)}</span></td></tr>; })}</tbody></table>
      {res.data.truncated && <p>عُرض آخر 1000 حركة؛ ضيّق الفترة لرؤية الباقي.</p>}</div></>);
}
export default function CashMovements() { return <Suspense fallback={null}><Inner /></Suspense>; }
