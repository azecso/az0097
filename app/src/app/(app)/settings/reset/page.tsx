"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import { useLoad } from "@/components/ui";

const PHRASE = "تصفير كل البيانات";
interface Prep { file: string; sha256: string; bytes: number; attachments: number; rows: Record<string, number> }
export default function ResetPage() {
  const st = useLoad<{ enabled: boolean } | null>("/api/settings/reset", null).data;
  const [prep, setPrep] = useState<Prep | null>(null), [phrase, setPhrase] = useState(""), [code, setCode] = useState(""), [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null), [busy, setBusy] = useState(false);
  async function prepare() {
    setBusy(true); setMsg(null);
    try { setPrep(await api<Prep>("/api/settings/reset", { method: "POST", body: { action: "prepare" } })); } catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); }
  }
  async function run() {
    setBusy(true); setMsg(null);
    try { await api("/api/settings/reset", { method: "POST", body: { action: "reset", phrase, code: code || undefined } }); setMsg({ ok: true, t: "تم تصفير البيانات. الترقيم يبدأ من 1. النسخة محفوظة على الخادم." }); setPhrase(""); setCode(""); setPrep(null); }
    catch (e) { setMsg({ ok: false, t: (e as Error).message }); } finally { setBusy(false); }
  }
  const rows = prep ? Object.values(prep.rows).reduce((a, b) => a + b, 0) : 0;
  return (<><h1>تصفير البيانات</h1>
    <div className="msg err" role="alert">⚠ عملية خطرة. تُحذف كل الفواتير والسندات والحركات والعملاء والموردون والمنتجات والموظفون والمرفقات، ويبدأ الترقيم من 1. تبقى الإعدادات والمستخدمون والصلاحيات وشجرة الحسابات والصناديق وبنود المصروفات والشركاء. لا يمكن التراجع إلا باستعادة النسخة (scripts/restore-export.ts).</div>
    {st && !st.enabled && <div className="msg err" role="status">التصفير غير مفعّل على هذا الخادم. يلزم ضبط RESET_DATABASE_URL (اتصال مستقل بصلاحية واحدة) — راجع docs/RUNBOOK.md.</div>}
    {msg && <div className={`msg ${msg.ok ? "ok" : "err"}`} role="status">{msg.t}</div>}
    <div className="card"><h2>1) أنشئ نسخة كاملة موثّقة</h2>
      <p>تُحفظ على الخادم وتُقرأ للتحقق منها، وتشمل كل السجلات والمرفقات. أي عملية تحدث بعدها تُبطل النسخة وتلزم نسخة جديدة. لا تعتمد على هذه النسخة وحدها: يبقى النسخ التشغيلي الدوري (ops/backup.sh) هو الأساس.</p>
      <button className="primary" onClick={prepare} disabled={busy || !st?.enabled}>إنشاء النسخة</button>
      {prep && <p>✔ {prep.file} — {rows} سجل، {prep.attachments} مرفق، {Math.round(prep.bytes / 1024)} KB — <a href={`/api/settings/reset/download?file=${encodeURIComponent(prep.file)}`}>تنزيل نسخة على جهازك</a></p>}</div>
    <div className="card"><h2>2) أكّد</h2>
      <label htmlFor="ph">اكتب العبارة: <b>{PHRASE}</b></label><input id="ph" value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" />
      <label htmlFor="cd">رمز المصادقة الثنائية (إن كانت مفعّلة)</label><input id="cd" dir="ltr" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
      <button className="primary" disabled={busy || !prep || phrase.trim() !== PHRASE} onClick={run}>تصفير البيانات الآن</button></div></>);
}
