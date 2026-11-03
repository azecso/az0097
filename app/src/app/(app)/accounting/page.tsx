"use client";
import { money } from "@/lib/client";
import { useLoad } from "@/components/ui";

interface TB { rows: { code: string; name: string; type: string; debit: string; credit: string }[]; totalDebit: string; totalCredit: string; balanced: boolean }
interface J { id: string; entryNo: string; date: string; docType: string; memo: string | null; lines: { account: string; name: string; debit: string; credit: string }[] }
export default function Accounting() {
  const tb = useLoad<TB | null>("/api/reports/trial-balance", null), j = useLoad<J[]>("/api/journal", []);
  return (<>
    <h1>المحاسبة</h1>
    {tb.err && <div className="msg err">{tb.err}</div>}
    {tb.data && <><div className="grid"><div className="card stat"><div className="label">إجمالي المدين</div><div className="value"><span className="num">{money(tb.data.totalDebit)}</span></div></div>
      <div className="card stat"><div className="label">إجمالي الدائن</div><div className="value"><span className="num">{money(tb.data.totalCredit)}</span></div></div>
      <div className="card stat"><div className="label">ميزان المراجعة</div><div className="value">{tb.data.balanced ? "✔ متوازن" : "⚠ غير متوازن"}</div></div></div>
      <h2>ميزان المراجعة</h2>
      <div className="card cards-as-list"><table><thead><tr><th>الحساب</th><th>الاسم</th><th>مدين</th><th>دائن</th></tr></thead>
        <tbody>{tb.data.rows.map((r) => <tr key={r.code}><td><span className="num">{r.code}</span></td><td>{r.name}</td><td><span className="num">{money(r.debit)}</span></td><td><span className="num">{money(r.credit)}</span></td></tr>)}
          {tb.data.rows.length === 0 && <tr><td colSpan={4}>لا توجد قيود بعد</td></tr>}</tbody></table></div></>}
    <h2>آخر القيود</h2>
    {j.data.map((e) => <div className="card" key={e.id} style={{ marginBottom: 8 }}><strong><span className="num">{e.entryNo}</span></strong> — <span className="num">{e.date}</span> — {e.memo}
      <table><tbody>{e.lines.map((l, i) => <tr key={i}><td><span className="num">{l.account}</span> {l.name}</td><td><span className="num">{money(l.debit)}</span></td><td><span className="num">{money(l.credit)}</span></td></tr>)}</tbody></table></div>)}
  </>);
}
