"use client";
import { useLoad } from "@/components/ui";

interface Ig { ok: boolean; backupsOk: boolean; checks: { code: string; ok: boolean; detail: string }[]; migrations: number; jobs: { kind: string; status: string; startedAt: string; finishedAt: string | null; size: string | null; error: string | null }[] }
const L: Record<string, string> = { TRIAL_BALANCE: "ميزان المراجعة متوازن", ENTRIES_BALANCED: "كل قيد متوازن", INVENTORY_RECONCILED: "مطابقة المخزون مع الدفتر", ACCOUNTING_EQUATION: "معادلة الميزانية", NO_NEGATIVE_STOCK: "لا مخزون سالب", NO_NEGATIVE_CASH: "لا صندوق سالب", BACKUP_FRESH_26H: "نسخة احتياطية خلال 26 ساعة", RESTORE_DRILL_35D: "اختبار استعادة خلال 35 يوماً" };
const K: Record<string, string> = { DAILY: "يومية", WEEKLY: "أسبوعية", MONTHLY: "شهرية", RESTORE_TEST: "اختبار استعادة" };
export default function BackupPage() {
  const { data, err } = useLoad<Ig | null>("/api/health/integrity", null);
  return (<><h1>سلامة البيانات والنسخ الاحتياطي</h1>
    <p>النسخ مشفّرة (age) ومحفوظة خارج الخادم؛ المفتاح الخاص بحوزتك أنت فقط. يُجرى اختبار استعادة شهري على قاعدة منفصلة. التفاصيل في <code>docs/RUNBOOK.md</code>.</p>
    {err && <div className="msg err">{err}</div>}
    {data && <><div className={`msg ${data.ok ? "ok" : "err"}`} role="status">{data.ok ? "✔ الدفاتر سليمة" : "⛔ توجد مشكلة في سلامة الدفاتر"} {data.backupsOk ? "• ✔ النسخ الاحتياطي حديث" : "• ⚠ النسخ الاحتياطي أو اختبار الاستعادة متأخر/غير مفعّل"}</div>
      <div className="card cards-as-list"><table><thead><tr><th>الفحص</th><th>النتيجة</th><th>التفاصيل</th></tr></thead><tbody>{data.checks.map((c) => <tr key={c.code}><td>{L[c.code] ?? c.code}</td><td>{c.ok ? "✔" : "⛔"}</td><td><span className="num">{c.detail}</span></td></tr>)}</tbody></table></div>
      <h2>آخر العمليات</h2><div className="card cards-as-list"><table><thead><tr><th>النوع</th><th>الحالة</th><th>البدء</th><th>الحجم</th><th>خطأ</th></tr></thead>
        <tbody>{data.jobs.map((j, i) => <tr key={i}><td>{K[j.kind]}</td><td>{j.status === "OK" ? "✔ ناجحة" : j.status === "FAILED" ? "⛔ فشلت" : "⏳"}</td><td><span className="num">{new Date(j.startedAt).toLocaleString("en-GB")}</span></td><td><span className="num">{j.size ?? "—"}</span></td><td>{j.error ?? ""}</td></tr>)}
          {data.jobs.length === 0 && <tr><td colSpan={5}>لا توجد عمليات نسخ مسجلة — فعّل النسخ الاحتياطي (انظر Runbook)</td></tr>}</tbody></table></div></>}</>);
}
