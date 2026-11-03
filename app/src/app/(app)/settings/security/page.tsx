"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import { MsgBox, useAction, useLoad } from "@/components/ui";

export default function Security() {
  const { data, reload } = useLoad<{ enabled: boolean; required: boolean } | null>("/api/auth/totp", null); const { msg, busy, run } = useAction(reload);
  const [sec, setSec] = useState<{ secret: string; otpauth: string } | null>(null); const [code, setCode] = useState("");
  return (<><h1>الأمان — المصادقة الثنائية (TOTP)</h1>
    <p>تُطلب عند تسجيل الدخول وعند العمليات الحساسة (اعتماد رأس المال، تسوية الأرباح، دفعات الأرباح، إعادة فتح فترة). استخدم تطبيق مصادقة (Google/Microsoft Authenticator أو غيره).</p>
    {data && <div className="card" style={{ display: "grid", gap: 12 }}>
      <div>الحالة: <strong>{data.enabled ? "✔ مفعّلة" : "غير مفعّلة"}</strong> {data.required && !data.enabled && <span className="badge">مطلوبة لتنفيذ العمليات الحساسة</span>}</div>
      {!data.enabled && !sec && <button className="primary" disabled={busy} onClick={async () => { const r = await run(() => api<{ secret: string; otpauth: string }>("/api/auth/totp", { method: "POST", body: { action: "setup" } }), "أُنشئ المفتاح"); if (r) setSec(r); }}>بدء الإعداد</button>}
      {sec && <><p>أضف هذا المفتاح يدوياً في تطبيق المصادقة (نوع: زمني): <strong className="num" style={{ userSelect: "all" }}>{sec.secret}</strong></p><p style={{ wordBreak: "break-all", color: "var(--muted)" }} className="num">{sec.otpauth}</p>
        <div className="row"><div><label htmlFor="c">أدخل الرمز من التطبيق للتأكيد</label><input id="c" value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" inputMode="numeric" maxLength={6} /></div><button className="primary" disabled={busy || code.length !== 6} onClick={async () => { if (await run(() => api("/api/auth/totp", { method: "POST", body: { action: "enable", code } }), "فُعّلت المصادقة الثنائية")) setSec(null); }}>تفعيل</button></div></>}
      {data.enabled && <div className="row"><div><label htmlFor="d">رمز حالي لتعطيلها</label><input id="d" value={code} onChange={(e) => setCode(e.target.value)} dir="ltr" maxLength={6} /></div><button className="danger" disabled={busy || code.length !== 6} onClick={() => run(() => api("/api/auth/totp", { method: "POST", body: { action: "disable", code } }), "عُطّلت")}>تعطيل</button></div>}
      <MsgBox msg={msg} /></div>}</>);
}
