"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import { useMe } from "@/components/me";
import { MsgBox, useAction, useLoad } from "@/components/ui";

interface P { month: string; status: string; closedAt: string | null; reopenedAt: string | null; reopenReason: string | null }
export default function Periods() {
  const me = useMe(); const { data, reload } = useLoad<P[]>("/api/periods", []); const { msg, busy, run } = useAction(reload); const [m, setM] = useState(""); const [reason, setReason] = useState(""); const [totp, setTotp] = useState("");
  return (<><h1>إقفال الفترات المحاسبية</h1>
    <p>الشهر المقفل يرفض أي ترحيل مؤرخ داخله. يُقفل الشهر المنتهي فقط ولا توجد فيه مسودات. إعادة الفتح للمالك بسبب مكتوب ورمز المصادقة، وتُسجَّل في التدقيق.</p>
    {me.user.isOwner && <div className="card row"><div><label htmlFor="m">الشهر</label><input id="m" type="month" value={m} onChange={(e) => setM(e.target.value)} /></div>
      <div><label htmlFor="r">سبب إعادة الفتح</label><input id="r" value={reason} onChange={(e) => setReason(e.target.value)} /></div><div><label htmlFor="t">رمز المصادقة</label><input id="t" value={totp} onChange={(e) => setTotp(e.target.value)} dir="ltr" maxLength={6} /></div>
      <button className="primary" disabled={busy || !m} onClick={() => run(() => api("/api/periods", { method: "POST", body: { month: m } }), "أُقفل الشهر")}>إقفال</button>
      <button className="danger" disabled={busy || !m || reason.length < 3} onClick={() => run(() => api("/api/periods", { method: "DELETE", body: { month: m, reason, totp: totp || null } }), "أُعيد فتح الشهر")}>إعادة فتح</button></div>}
    <MsgBox msg={msg} />
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الشهر</th><th>الحالة</th><th>سبب إعادة الفتح</th></tr></thead>
      <tbody>{data.map((p) => <tr key={p.month}><td><span className="num">{p.month.slice(0, 7)}</span></td><td>{p.status === "CLOSED" ? "🔒 مقفل" : "مفتوح (أُعيد فتحه)"}</td><td>{p.reopenReason ?? "—"}</td></tr>)}
        {data.length === 0 && <tr><td colSpan={3}>لا توجد فترات مقفلة</td></tr>}</tbody></table></div></>);
}
