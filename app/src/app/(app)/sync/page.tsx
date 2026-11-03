"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { can, useMe } from "@/components/me";
import { useOffline } from "@/lib/offline/use";
import { discardDoc, enqueueSubmit, exportAll, listDocs, retryOp, statusOf, titleOf, type DocStatus, type LocalDoc } from "@/lib/offline/store";
import { setupVault, unlockVault, lockVault, validPin, wipeVault } from "@/lib/offline/vault";
import { refreshReference } from "@/lib/offline/sync";

const ST: Record<DocStatus, [string, string]> = { PENDING: ["⏳ بانتظار المزامنة", ""], SYNCED: ["✔ مُزامَنة (مسودة على الخادم)", "var(--accent)"], POSTED: ["✔ رُحِّلت على الخادم", "var(--accent)"], CONFLICT: ["⚠ تعارض", "var(--danger)"], REJECTED: ["⛔ مرفوضة", "var(--danger)"] };
const ENT: Record<string, string> = { sales_invoice: "فاتورة بيع", sales_quote: "عرض سعر", customer_receipt: "سند قبض", expense: "مصروف" };
const PATH: Record<string, string> = { sales_invoice: "/sales/", sales_quote: "/sales/quotes", customer_receipt: "/sales/receipts", expense: "/expenses" };
const CODES: Record<string, string> = { INSUFFICIENT_STOCK: "المخزون لم يعد كافياً (بيع آخر سبقه). عدّل الكمية أو أعد المحاولة بعد وصول بضاعة.", INSUFFICIENT_CASH: "رصيد الصندوق لا يكفي.", CREDIT_LIMIT_EXCEEDED: "تجاوز الحد الائتماني للعميل.", PERIOD_CLOSED: "الفترة المحاسبية مقفلة.", VERSION_CONFLICT: "عُدّلت المسودة من جهة أخرى بعد نسختك.", PERMISSION_DENIED: "صلاحيتك لا تسمح بهذه العملية الآن.", VALIDATION: "بيانات غير صالحة." };

export default function SyncPage() {
  const me = useMe(); const off = useOffline(); const [docs, setDocs] = useState<{ d: LocalDoc; title: string }[]>([]); const [pin, setPin] = useState(""); const [pin2, setPin2] = useState(""); const [msg, setMsg] = useState("");
  const load = useCallback(async () => { const l = await listDocs(); setDocs(await Promise.all(l.map(async (d) => ({ d, title: await titleOf(d) })))); }, []);
  useEffect(() => { void load(); }, [load, off.pending, off.problems, off.vault.unlocked, off.syncing]);
  const err = (e: unknown) => setMsg((e as Error).message);
  return (<>
    <h1>المزامنة والعمل دون إنترنت</h1>
    <div className="card" style={{ display: "grid", gap: 8 }}>
      <div>الاتصال: <strong>{off.online ? "🟢 متصل" : "🔴 غير متصل"}</strong> • بانتظار المزامنة: <strong>{off.pending}</strong> • تعارضات/رفض: <strong>{off.problems}</strong> • آخر مزامنة: <span className="num">{off.lastSync ? new Date(off.lastSync).toLocaleString("en-GB") : "—"}</span></div>
      {off.lastError && <div className="msg err" role="alert">{off.lastError}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button className="primary" disabled={!off.online || off.syncing} onClick={() => off.flush()}>{off.syncing ? "جارٍ المزامنة…" : "مزامنة الآن"}</button>
        <button onClick={async () => { const t = await exportAll(); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([t], { type: "application/json" })); a.download = "drafts-backup.json"; a.click(); }}>تصدير المسودات (نسخة أمان)</button></div></div>
    <h2>القفل المحلي (تشفير بيانات الجهاز)</h2>
    <div className="card" style={{ display: "grid", gap: 10 }}>
      <p>المسودات وبيانات الأصناف والعملاء المخبّأة تُشفَّر على جهازك بمفتاح مشتق من رقم سري. لا تُخزَّن كلمات المرور ولا الأرصدة ولا الأرباح. <strong>العمل أوفلاين يتطلب تفعيل القفل.</strong></p>
      {!off.vault.initialized && <div className="row"><div><label htmlFor="p1">رقم سري (6–12 رقماً)</label><input id="p1" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} dir="ltr" autoComplete="new-password" /></div>
        <div><label htmlFor="p2">تأكيد الرقم</label><input id="p2" type="password" inputMode="numeric" value={pin2} onChange={(e) => setPin2(e.target.value)} dir="ltr" autoComplete="new-password" /></div>
        <button className="primary" disabled={!validPin(pin) || pin !== pin2} onClick={() => setupVault(pin, me.user.username).then(async () => { setPin(""); setPin2(""); setMsg("فُعّل القفل المحلي"); if (navigator.onLine) await refreshReference().catch(() => {}); }).catch(err)}>تفعيل القفل</button></div>}
      {off.vault.initialized && !off.vault.unlocked && <div className="row"><div><label htmlFor="pu">الرقم السري</label><input id="pu" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} dir="ltr" autoComplete="current-password" /></div>
        <button className="primary" onClick={() => unlockVault(pin).then(async () => { setPin(""); setMsg("فُتح القفل"); if (navigator.onLine) await refreshReference().catch(() => {}); }).catch(err)}>فتح</button></div>}
      {off.vault.initialized && off.vault.unlocked && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button onClick={() => lockVault()}>🔒 قفل الآن</button><button disabled={!off.online} onClick={() => refreshReference().then(() => setMsg("حُدّثت البيانات المخبّأة")).catch(err)}>تحديث بيانات الأصناف والعملاء</button>
        <button className="danger" onClick={async () => { if (confirm("سيُحذف كل ما على هذا الجهاز من مسودات غير مزامنة. متأكد؟")) { await wipeVault(); setMsg("مُسحت بيانات الجهاز"); void load(); } }}>مسح بيانات الجهاز</button></div>}
      {msg && <div className="msg" role="status">{msg}</div>}</div>
    <h2>مستندات هذا الجهاز</h2>
    <div className="card cards-as-list"><table><thead><tr><th>النوع</th><th>البيان</th><th>الحالة</th><th>التفاصيل</th><th></th></tr></thead>
      <tbody>{docs.map(({ d, title }) => { const st = statusOf(d); const bad = [...d.ops].reverse().find((o) => o.state === "CONFLICT" || o.state === "REJECTED");
        return <tr key={d.localId}><td>{ENT[d.entityType]}</td><td>{title} <small className="num">{d.draftRef ?? d.localId.slice(0, 8)}</small></td><td style={{ color: ST[st][1] }}>{ST[st][0]}{d.docNo && <> <span className="num">{d.docNo}</span></>}</td>
          <td>{bad ? (CODES[bad.code ?? ""] ?? bad.message ?? bad.code) : st === "SYNCED" ? "المسودة على الخادم دون رقم نهائي حتى تطلب الترحيل" : st === "PENDING" ? "ستُرسل عند عودة الاتصال" : ""}</td>
          <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {st === "SYNCED" && d.serverId && ["sales_invoice", "sales_quote", "customer_receipt", "expense"].includes(d.entityType) && can(me, d.entityType === "customer_receipt" ? "voucher:approve" : d.entityType === "expense" ? "expense:approve" : "sales:approve") && <button className="primary" onClick={() => enqueueSubmit(d.localId).then(() => off.flush())}>طلب الترحيل (يتحقق الخادم)</button>}
            {(st === "CONFLICT" || st === "REJECTED") && bad?.op === "SUBMIT_FOR_POSTING" && <button onClick={() => retryOp(d.localId).then(() => off.flush())}>إعادة المحاولة</button>}
            {d.serverId && d.entityType === "sales_invoice" && <Link href={`/sales/${d.serverId}`}><button>فتح على الخادم</button></Link>}{d.serverId && d.entityType !== "sales_invoice" && <Link href={PATH[d.entityType]!}><button>فتح القائمة</button></Link>}
            {st !== "POSTED" && <button className="danger" onClick={() => confirm(d.serverId ? "حذف السجل المحلي فقط (المسودة على الخادم تبقى وتُحذف من شاشتها)" : "حذف هذه المسودة من الجهاز؟") && discardDoc(d.localId)}>حذف محلي</button>}</td></tr>; })}
        {docs.length === 0 && <tr><td colSpan={5}>لا توجد مستندات على هذا الجهاز</td></tr>}</tbody></table></div>
    <div className="card" style={{ marginTop: 12 }}><strong>كيف يعمل؟</strong><ul><li>دون إنترنت: تُحفظ <b>المسودات فقط</b> (فاتورة بيع، عرض سعر، سند قبض، مصروف) مشفّرة على جهازك.</li><li>عند عودة الاتصال تُرسل تلقائياً؛ الخادم وحده يصدر الرقم النهائي ويرحّل ويخصم المخزون (FIFO) ويتحقق من الصندوق والصلاحية والفترة.</li><li>بيعان من جهازين على نفس الرصيد: الأول يُرحَّل والثاني يظهر «تعارض» وتبقى مسودته لتعديلها — لا يصير المخزون سالباً أبداً.</li><li>لا يُعتمد «آخر تعديل يفوز» على المبالغ: التعارض في نسخة المسودة يُعرض لك لتقرر.</li></ul></div>
  </>);
}
