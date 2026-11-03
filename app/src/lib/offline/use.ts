"use client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api, ApiError } from "../client";
import { flush, lastSync, loadReference, onSyncState, refreshReference, syncState, type Reference } from "./sync";
import { enqueueCreate, listDocs, onStoreChange, statusOf } from "./store";
import { isUnlocked, onVaultChange, vaultStatus } from "./vault";

export function useVaultUnlocked() { return useSyncExternalStore((cb) => onVaultChange(cb), () => isUnlocked(), () => false); }

function useOnlineStatus() {
  return useSyncExternalStore((cb) => { window.addEventListener("online", cb); window.addEventListener("offline", cb); return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); }; }, () => navigator.onLine, () => true);
}

/** Connectivity, queue size, problems and vault state for the status bar and the sync page. */
export function useOffline() {
  const online = useOnlineStatus(); const [pending, setPending] = useState(0); const [problems, setProblems] = useState(0); const [stale, setStale] = useState(false);
  const [vault, setVault] = useState({ initialized: false, unlocked: false, userId: null as string | null }); const [, tick] = useState(0); const [last, setLast] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { const docs = await listDocs(); const st = docs.map(statusOf); setPending(st.filter((s) => s === "PENDING").length); setProblems(st.filter((s) => s === "CONFLICT" || s === "REJECTED").length);
      setStale(docs.some((d) => statusOf(d) === "PENDING" && Date.now() - Date.parse(d.createdAt) > 24 * 3600 * 1000)); setVault(await vaultStatus()); setLast(await lastSync()); } catch { /* IndexedDB unavailable (private mode) */ }
  }, []);
  useEffect(() => { void refresh(); const a = onStoreChange(() => void refresh()), b = onVaultChange(() => void refresh()), c = onSyncState(() => tick((n) => n + 1)); return () => { a(); b(); c(); }; }, [refresh]);
  useEffect(() => { if (online) void flush(); }, [online, vault.unlocked]);                      // reconnect, or the vault was just unlocked
  useEffect(() => { if (!online || pending === 0) return; const t = setInterval(() => void flush(), 60_000); return () => clearInterval(t); }, [online, pending]);
  const s = syncState();
  return { online, pending, problems, stale, vault, syncing: s.syncing, lastError: s.lastError, lastSync: s.lastSync ?? last, flush: () => flush(), refresh };
}

/** Reference list for form selects: live from the API when online, from the encrypted snapshot when offline. */
export function useRefList<T>(key: keyof Reference, apiPath: string, filter?: (x: T) => boolean): { data: T[]; offline: boolean } {
  const [data, setData] = useState<T[]>([]); const [offline, setOffline] = useState(false); const online = useOnlineStatus(); const unlocked = useVaultUnlocked();
  useEffect(() => {
    let dead = false;
    (async () => {
      if (online) { try { const r = await api<T[]>(apiPath); if (!dead) { setData(filter ? r.filter(filter) : r); setOffline(false); } if (isUnlocked()) void refreshReference().catch(() => {}); return; } catch (e) { if (e instanceof ApiError) return; } }
      const ref = isUnlocked() ? await loadReference().catch(() => null) : null;
      if (!dead && ref) { const rows = ref[key] as unknown as T[]; setData(filter ? rows.filter(filter) : rows); setOffline(true); }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, apiPath, key, unlocked]);
  return { data, offline };
}

export interface CreateResult { mode: "online" | "queued"; id?: string; localId?: string }
/** Online: normal API call. Offline (or network failure): seals the payload in the local vault as a draft operation to be validated by the server later. */
export async function createDraft(o: { entityType: string; endpoint: string; payload: Record<string, unknown>; title: string }): Promise<CreateResult> {
  if (navigator.onLine) {
    try { const r = await api<{ id: string }>(o.endpoint, { method: "POST", body: o.payload }); return { mode: "online", id: r.id }; }
    catch (e) { if (e instanceof ApiError) throw e; /* network failure: fall through to the offline queue */ }
  }
  if (!isUnlocked()) throw new Error("لا يوجد اتصال. فعّل «القفل المحلي» (صفحة المزامنة) وافتحه لحفظ المسودة على الجهاز");
  return { mode: "queued", localId: await enqueueCreate(o.entityType, o.payload, o.title) };
}
