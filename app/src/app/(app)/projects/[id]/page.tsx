"use client";
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { FxRateField } from "@/components/fx-rate-field";
import { MsgBox, StatusBadge, useAction, useLoad, ReverseBox } from "@/components/ui";

interface E { id: string; docNo: string; docDate: string; kind: "SPEND" | "REFUND"; currency: string; amount: string; note: string | null; status: string; cashAccount: string; createdBy: string; photos: number }
interface Proj { id: string; name: string; notes: string | null; status: string; entries: E[]; totals: { currency: string; spent: string; refunded: string; net: string }[] }
interface Cash { id: string; name: string; currency: string; kind: string }
const typedRate = () => (document.getElementById("pr-rate") as HTMLInputElement | null)?.value?.trim() || null;
export default function ProjectPage() {
  const { id } = useParams<{ id: string }>(); const me = useMe(); const { data: p, reload } = useLoad<Proj | null>(`/api/projects/${id}`, null);
  const cash = useLoad<Cash[]>("/api/cash-accounts", []).data.filter((c) => c.kind !== "PARTNER_CUSTODY");
  const { msg, busy, run } = useAction(reload); const [kind, setKind] = useState<"SPEND" | "REFUND">("SPEND"); const [acct, setAcct] = useState(""); const [file, setFile] = useState<File | null>(null);
  const [rid, setRid] = useState(() => `proj-${crypto.randomUUID()}`);
  const ca = cash.find((c) => c.id === (acct || cash[0]?.id));
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); const photo = file;
    const r = await run(async () => {
      const res = await api<{ id: string; docNo: string }>(`/api/projects/${id}/entries`, { method: "POST", body: { requestId: rid, kind, docDate: String(f.get("date")), cashAccountId: ca!.id, amount: String(f.get("amount")), exchangeRate: ca!.currency === "IQD" ? null : typedRate(), note: String(f.get("note") ?? "") || null } });
      if (photo) {                                              // the receipt photo is attached to the entry that was just saved (the money has already moved)
        const me2 = await api<{ csrf: string }>("/api/auth/me"); const fd = new FormData(); fd.set("entityType", "project_entry"); fd.set("entityId", res.id); fd.set("file", photo);
        const up = await fetch("/api/attachments", { method: "POST", headers: { "x-csrf-token": me2.csrf }, body: fd, credentials: "same-origin" });
        if (!up.ok) throw new Error(`حُفظت الحركة ${res.docNo} لكن فشل رفع الصورة: ${(await up.json().catch(() => ({})))?.error?.message ?? "خطأ"}. أضفها من صف الحركة.`);
      }
      return res;
    }, kind === "SPEND" ? "تم الصرف وخُصم من الصندوق" : "تم تسجيل الاسترجاع وعاد المبلغ للصندوق");
    if (r) { form.reset(); setFile(null); setRid(`proj-${crypto.randomUUID()}`); }
  }
  async function addPhoto(entryId: string, file: File) {
    await run(async () => { const me2 = await api<{ csrf: string }>("/api/auth/me"); const fd = new FormData(); fd.set("entityType", "project_entry"); fd.set("entityId", entryId); fd.set("file", file);
      const up = await fetch("/api/attachments", { method: "POST", headers: { "x-csrf-token": me2.csrf }, body: fd, credentials: "same-origin" }); if (!up.ok) throw new Error((await up.json().catch(() => ({})))?.error?.message ?? "فشل الرفع"); return true; }, "أُضيفت الصورة");
  }
  if (!p) return <p>جارٍ التحميل…</p>;
  return (<>
    <p><Link href="/projects">← المشاريع</Link></p>
    <h1>{p.name}</h1>{p.notes && <p>{p.notes}</p>}
    <div className="card row">{p.totals.length ? p.totals.map((t) => <div key={t.currency}><div>المصروف: <b className="num">{money(t.spent)} {t.currency}</b></div><div>المسترجع: <b className="num">{money(t.refunded)} {t.currency}</b></div><div>صافي التكلفة: <b className="num">{money(t.net)} {t.currency}</b></div></div>) : <div>لا حركات بعد</div>}</div>
    {can(me, "expense:create") && p.status === "OPEN" && <form className="card" onSubmit={save} style={{ display: "grid", gap: 12, marginTop: 12 }}>
      <div role="tablist" style={{ display: "flex", gap: 8 }}><button type="button" role="tab" aria-selected={kind === "SPEND"} className={kind === "SPEND" ? "primary" : ""} onClick={() => setKind("SPEND")}>صرف على المشروع</button>
        <button type="button" role="tab" aria-selected={kind === "REFUND"} className={kind === "REFUND" ? "primary" : ""} onClick={() => setKind("REFUND")}>استرجاع مبلغ</button></div>
      <div className="row">
        <div><label htmlFor="pa">المبلغ</label><input id="pa" name="amount" inputMode="decimal" dir="ltr" required /></div>
        <div><label htmlFor="pd">التاريخ</label><input id="pd" name="date" type="date" defaultValue={today()} required /></div>
        <div><label htmlFor="pc">{kind === "SPEND" ? "يُخصم من الصندوق" : "يعود إلى الصندوق"}</label><select id="pc" value={acct || cash[0]?.id || ""} onChange={(e) => setAcct(e.target.value)}>{cash.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}</select></div>
        {ca && ca.currency !== "IQD" && <FxRateField id="pr-rate" name="pr-rate" label="سعر صرف يوم الحركة (فارغ = سعر اليوم)" />}</div>
      <div><label htmlFor="pn">ملاحظة</label><input id="pn" name="note" /></div>
      <div><label htmlFor="pf">صورة الإيصال (اختيارية — من المعرض أو الكاميرا)</label><input id="pf" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />{file && <small> {file.name}</small>}</div>
      <MsgBox msg={msg} /><button className="primary" disabled={busy || !ca}>{kind === "SPEND" ? "تسجيل الصرف" : "تسجيل الاسترجاع"}</button></form>}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>النوع</th><th>المبلغ</th><th>الصندوق</th><th>الملاحظة</th><th>الصورة</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{p.entries.map((e) => <tr key={e.id}><td><span className="num">{e.docNo}</span></td><td><span className="num">{e.docDate}</span></td><td>{e.kind === "SPEND" ? "صرف" : "استرجاع"}</td>
        <td><span className="num">{e.kind === "SPEND" ? "−" : "+"}{money(e.amount)} {e.currency}</span></td><td>{e.cashAccount}</td><td>{e.note ?? ""}</td>
        <td><EntryPhotos entryId={e.id} count={e.photos} canAdd={can(me, "expense:create") && e.status === "POSTED"} onAdd={(f) => addPhoto(e.id, f)} /></td><td><StatusBadge s={e.status} /></td>
        <td>{e.status === "POSTED" && can(me, "expense:cancel") && <ReverseBox label="إلغاء" busy={busy} onReverse={(reason) => run(() => api(`/api/project-entries/${e.id}/reverse`, { method: "POST", body: { reason } }), "تم الإلغاء")} />}</td></tr>)}
        {p.entries.length === 0 && <tr><td colSpan={9}>لا توجد حركات</td></tr>}</tbody></table></div></>);
}

function EntryPhotos({ entryId, count, canAdd, onAdd }: { entryId: string; count: number; canAdd: boolean; onAdd: (f: File) => void }) {
  const items = useLoad<{ id: string; name: string; mime: string }[]>(`/api/attachments?entityType=project_entry&entityId=${entryId}&n=${count}`, []).data;
  return (<div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
    {items.map((a) => <a key={a.id} href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">{a.mime.startsWith("image/") ? <img src={`/api/attachments/${a.id}`} alt={a.name} style={{ height: 36, borderRadius: 6 }} /> : a.name}</a>)}
    {canAdd && <label className="badge" style={{ cursor: "pointer" }}>＋<input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" capture="environment" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) onAdd(f); e.target.value = ""; }} /></label>}</div>);
}
