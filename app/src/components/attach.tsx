"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";

interface A { id: string; name: string; mime: string; size: number }

/** Uploads/lists attachments of one entity. The server checks the real file type, the 5MB limit and the permission. */
export function Attach({ entityType, entityId, label = "المرفقات", accept = "image/png,image/jpeg,image/webp,application/pdf", single = false }: { entityType: string; entityId: string; label?: string; accept?: string; single?: boolean }) {
  const [items, setItems] = useState<A[]>([]); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const load = () => api<A[]>(`/api/attachments?entityType=${entityType}&entityId=${entityId}`).then(setItems).catch((e) => setErr(e.message));
  useEffect(() => { void load(); }, [entityType, entityId]);
  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return; setBusy(true); setErr("");
    try {
      const fd = new FormData(); fd.set("entityType", entityType); fd.set("entityId", entityId); fd.set("file", f);
      const me = await api<{ csrf: string }>("/api/auth/me");
      const r = await fetch("/api/attachments", { method: "POST", headers: { "x-csrf-token": me.csrf }, body: fd, credentials: "same-origin" });
      const j = await r.json(); if (!r.ok) throw new Error(j?.error?.message ?? "فشل الرفع");
      await load(); if (single) window.location.reload();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); e.target.value = ""; }
  }
  async function del(id: string) { try { await api(`/api/attachments/${id}`, { method: "DELETE" }); await load(); } catch (x) { setErr((x as Error).message); } }
  return (<div className="card" style={{ marginTop: 12 }}><strong>{label}</strong>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>{items.map((a) => <div key={a.id} className="badge" style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {a.mime.startsWith("image/") ? <a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer"><img src={`/api/attachments/${a.id}`} alt={a.name} style={{ height: 44, borderRadius: 6 }} /></a> : <a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">📄 {a.name}</a>}
      <button onClick={() => del(a.id)} aria-label={`حذف ${a.name}`} className="danger" style={{ minHeight: 28, padding: "0 8px" }}>×</button></div>)}{items.length === 0 && <span style={{ color: "var(--muted)" }}>لا مرفقات</span>}</div>
    <label className="badge" style={{ cursor: "pointer", display: "inline-block" }}>{busy ? "جارٍ الرفع…" : "+ إضافة ملف (حتى 5MB)"}<input type="file" accept={accept} onChange={upload} disabled={busy} style={{ display: "none" }} /></label>
    {err && <div className="msg err" role="alert">{err}</div>}</div>);
}
