"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { can, useMe } from "@/components/me";

interface Rate { id: string; currency: string; rateDate: string; rate: string }
export default function Fx() {
  const me = useMe(); const [rows, setRows] = useState<Rate[]>([]); const [msg, setMsg] = useState<{ t: "ok" | "err"; m: string } | null>(null);
  const load = () => api<Rate[]>("/api/fx-rates?currency=USD").then(setRows).catch((e) => setMsg({ t: "err", m: e.message }));
  useEffect(() => { void load(); }, []);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setMsg(null);
    try { await api("/api/fx-rates", { method: "POST", body: { currency: "USD", rateDate: String(f.get("date")), rate: String(f.get("rate")).trim() } }); setMsg({ t: "ok", m: "تم حفظ السعر" }); await load(); }
    catch (x) { setMsg({ t: "err", m: (x as Error).message }); }
  }
  return (<>
    <h1>أسعار الصرف</h1>
    <p>العملة الأساس: دينار عراقي. السعر = عدد الدنانير لكل 1 دولار، يُدخل يدوياً لكل يوم، ويُثبَّت في كل مستند عند إنشائه ولا يتغير بعد الترحيل.</p>
    {can(me, "fx_rate:create") && <form className="card row" onSubmit={save}>
      <div><label htmlFor="d">التاريخ</label><input id="d" name="date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></div>
      <div><label htmlFor="r">IQD لكل 1 USD</label><input id="r" name="rate" inputMode="decimal" pattern="\d{1,10}(\.\d{1,8})?" required dir="ltr" placeholder="1480" /></div>
      <button className="primary">حفظ</button></form>}
    {msg && <div className={`msg ${msg.t}`} role="status">{msg.m}</div>}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>التاريخ</th><th>السعر (IQD/USD)</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.id}><td><span className="num">{r.rateDate}</span></td><td><span className="num">{r.rate}</span></td></tr>)}
        {rows.length === 0 && <tr><td colSpan={2}>لا توجد أسعار بعد</td></tr>}</tbody></table></div>
  </>);
}
