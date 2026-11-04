"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

export type Msg = { t: "ok" | "err"; m: string } | null;
export function MsgBox({ msg }: { msg: Msg }) { return msg ? <div className={`msg ${msg.t}`} role="status">{msg.m}</div> : null; }

/** Loads JSON from the API and exposes reload(). */
export function useLoad<T>(path: string | null, initial: T) {
  const [data, setData] = useState<T>(initial); const [err, setErr] = useState("");
  const reload = useCallback(() => { if (!path) return Promise.resolve(); return api<T>(path).then((d) => { setData(d); setErr(""); }).catch((e) => setErr(e.message)); }, [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, err, reload };
}

export function useAction(onDone?: () => void) {
  const [msg, setMsg] = useState<Msg>(null); const [busy, setBusy] = useState(false);
  const run = async <R,>(fn: () => Promise<R>, okText: string): Promise<R | undefined> => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); setMsg({ t: "ok", m: okText }); onDone?.(); return r; }
    catch (e) { setMsg({ t: "err", m: (e as Error).message }); return undefined; } finally { setBusy(false); }
  };
  return { msg, busy, run, setMsg };
}

export const STATUS_AR: Record<string, string> = { DRAFT: "مسودة", IN_REVIEW: "قيد المراجعة", POSTED: "مرحّل", REVERSED: "معكوس" };
export function StatusBadge({ s }: { s: string }) { return <span className="badge">{s === "POSTED" ? "✔ " : s === "REVERSED" ? "↩ " : "✎ "}{STATUS_AR[s] ?? s}</span>; }

/** Reverse-with-reason control with its OWN text state, so typing a reason on one row never fills the other rows. */
export function ReverseBox({ busy, onReverse, label = "عكس" }: { busy?: boolean; onReverse: (reason: string) => unknown; label?: string }) {
  const [reason, setReason] = useState("");
  return (<><input aria-label="سبب العكس" placeholder="سبب العكس" style={{ maxWidth: 160 }} value={reason} onChange={(e) => setReason(e.target.value)} />
    <button className="danger" disabled={busy || reason.trim().length < 3} onClick={() => { void Promise.resolve(onReverse(reason.trim())).then(() => setReason("")); }}>{label}</button></>);
}
