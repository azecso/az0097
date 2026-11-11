"use client";
import { useState } from "react";
import { api } from "@/lib/client";

const PHRASE = "تصفير كل البيانات";
export default function ResetPage() {
  const [saved, setSaved] = useState(false), [phrase, setPhrase] = useState(""), [code, setCode] = useState(""), [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [busy, setBusy] = useState(false);
  async function backup() {
    setBusy(true); setMsg(null);
    try {
      const d = await api<unknown>("/api/settings/reset");
      const url = URL.createObjectURL(new Blob([JSON.stringify(d)], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = `backup-before-reset-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url);
      setSaved(true);
    } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); }
  }
  async function run() {
    setBusy(true); setMsg(null);
    try { await api("/api/settings/reset", { method: "POST", body: { phrase, code: code || undefined, backedUp: true } }); setMsg({ ok: true, t: "تم تصفير البيانات. الترقيم يبدأ من 1." }); setPhrase(""); setCode(""); }
    catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); }
  }
  return (<><h1>تصفير البيانات</h1>
    <div className="msg err" role="alert">⚠ عملية لا رجعة فيها. تُحذف كل الفواتير والسندات والحركات والعملاء والموردون والمنتجات والموظفون والمرفقات، ويبدأ الترقيم من 1. تبقى الإعدادات والمستخدمون والصلاحيات وشجرة الحسابات والصناديق وبنود المصروفات والشركاء.</div>
    {msg && <div className={`msg ${msg.ok ? "ok" : "err"}`} role="status">{msg.t}</div>}
    <div className="card"><h2>1) نزّل نسخة كاملة أولاً</h2><p>هذه النسخة هي طريقك الوحيد للرجوع.</p>
      <button className="primary" onClick={backup} disabled={busy}>تنزيل النسخة الاحتياطية</button> {saved && <span>✔ تم التنزيل</span>}</div>
    <div className="card"><h2>2) أكّد</h2>
      <label htmlFor="ph">اكتب العبارة: <b>{PHRASE}</b></label><input id="ph" value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" />
      <label htmlFor="cd">رمز المصادقة الثنائية (إن كانت مفعّلة)</label><input id="cd" dir="ltr" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
      <button className="primary" disabled={busy || !saved || phrase.trim() !== PHRASE} onClick={run}>تصفير البيانات الآن</button></div></>);
}
