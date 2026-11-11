"use client";
import { useLoad } from "@/components/ui";

interface Chk { code: string; title: string; ok: boolean; summary: string; rows: Record<string, string>[]; hint: string }
export default function Reconciliation() {
  const { data, err } = useLoad<{ ok: boolean; checks: Chk[] } | null>("/api/health/reconciliation", null);
  return (<><h1>مطابقة الدفاتر</h1>
    <p>مقارنة الأستاذ العام بكل دفتر مساعد (مخزون، نقد، عملاء، إيراد مؤجل، أرباح الشركاء). النتيجة الخضراء تعني أن الدفاتر متفقة مع بعضها، ولا تُثبت صحة الوقائع التجارية نفسها.</p>
    {err && <div className="msg err">{err}</div>}
    {data && <><div className={`msg ${data.ok ? "ok" : "err"}`} role="status">{data.ok ? "✔ كل المطابقات سليمة" : "⛔ توجد فروقات — التفاصيل أدناه"}</div>
      {data.checks.map((c) => <div className="card" key={c.code} style={{ marginTop: 12 }}>
        <h2>{c.ok ? "✔" : "⛔"} {c.title}</h2><p>{c.summary}</p>
        {!c.ok && <><p><small>{c.hint}</small></p>
          {c.rows.length > 0 && <div className="cards-as-list"><table><thead><tr>{Object.keys(c.rows[0]!).map((k) => <th key={k}>{k.replace(/_/g, " ")}</th>)}</tr></thead>
            <tbody>{c.rows.map((r, i) => <tr key={i}>{Object.values(r).map((v, j) => <td key={j}><span className="num">{v}</span></td>)}</tr>)}</tbody></table></div>}</>}</div>)}</>}</>);
}
