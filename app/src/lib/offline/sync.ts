import { api, ApiError, setCsrf } from "../client";
import { idbGet, idbPut } from "./idb";
import { emitStore, listDocs, payloadOf, putDoc, type LocalDoc, type QueuedOp } from "./store";
import { isUnlocked, seal, unseal, type Sealed } from "./vault";

export const deviceId = () => { let d = localStorage.getItem("erp-device"); if (!d) { d = "dev-" + crypto.randomUUID().slice(0, 12); localStorage.setItem("erp-device", d); } return d; };
interface Result { operationId: string; status: "ACCEPTED" | "REJECTED" | "CONFLICT"; code?: string; message?: string; serverId?: string; docNo?: string | null; draftRef?: string; version?: number }

const state = { syncing: false, lastSync: null as string | null, lastError: "" as string }; const subs = new Set<() => void>();
export const syncState = () => state; export const onSyncState = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const note = () => subs.forEach((f) => f());

/**
 * Sends queued operations in order. Safe to call anytime and from several tabs: the server is idempotent (operation_id / idempotency_key),
 * and a document whose earlier operation was rejected/conflicted is held until the user resolves it.
 */
export async function flush(): Promise<{ sent: number }> {
  if (state.syncing || !navigator.onLine) return { sent: 0 };
  const run = async () => {
    state.syncing = true; state.lastError = ""; note(); let sent = 0;
    try {
      setCsrf((await api<{ csrf: string }>("/api/auth/me")).csrf);                  // a fresh CSRF token (the page may have been opened offline)
      const docs = (await listDocs()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const pending: { doc: LocalDoc; op: QueuedOp }[] = [];
      for (const doc of docs) for (const op of doc.ops) { if (op.state === "QUEUED") pending.push({ doc, op }); else if (op.state !== "DONE") break; }
      if (pending.length > 0 && !isUnlocked()) { state.lastError = "افتح القفل المحلي لمزامنة المسودات"; return { sent: 0 }; }
      for (let i = 0; i < pending.length; i += 25) {
        const batch = pending.slice(i, i + 25);
        const operations = await Promise.all(batch.map(async ({ doc, op }) => ({ operationId: op.operationId, idempotencyKey: op.idempotencyKey, entityType: doc.entityType, entityLocalId: doc.localId, op: op.op, baseVersion: op.baseVersion,
          payload: { ...(await payloadOf(op)), ...(doc.serverId ? { serverId: doc.serverId } : {}) }, clientCreatedAt: op.clientCreatedAt })));
        const res = await api<{ results: Result[] }>("/api/sync/push", { method: "POST", body: { deviceId: deviceId(), operations } });
        for (const r of res.results) {
          const hit = batch.find((b) => b.op.operationId === r.operationId); if (!hit) continue;
          const doc = (await listDocs()).find((d) => d.localId === hit.doc.localId)!; const op = doc.ops.find((o) => o.operationId === r.operationId)!;
          op.state = r.status === "ACCEPTED" ? "DONE" : r.status; op.code = r.code; op.message = r.message;
          if (r.status === "ACCEPTED") { doc.serverId = r.serverId ?? doc.serverId; doc.draftRef = r.draftRef ?? doc.draftRef; doc.version = r.version ?? doc.version; if (r.docNo) doc.docNo = r.docNo; }
          await putDoc(doc); sent += 1;
        }
      }
      state.lastSync = new Date().toISOString(); await idbPut("meta", state.lastSync, "lastSync");
    } catch (e) { state.lastError = e instanceof ApiError ? (e.status === 401 ? "انتهت الجلسة — سجّل الدخول لمتابعة المزامنة" : e.message) : "تعذر الاتصال بالخادم — ستُعاد المحاولة"; }
    finally { state.syncing = false; note(); emitStore(); }
    return { sent };
  };
  const locks = (navigator as Navigator & { locks?: { request: (n: string, f: () => Promise<unknown>) => Promise<unknown> } }).locks;
  return locks ? ((await locks.request("erp-sync", run)) as { sent: number }) : run();
}

// ---- reference data (read-only snapshot used to fill forms offline) ----
export interface Reference { asOf: string; products: any[]; contacts: any[]; locations: any[]; cashAccounts: any[]; fxRates: any[]; company: any; expenseCategories: any[] }
export async function refreshReference(): Promise<void> { const r = await api<Reference>("/api/sync/reference"); await idbPut("ref", await seal(r), "snapshot"); emitStore(); }
export async function loadReference(): Promise<Reference | null> { const s = await idbGet<Sealed>("ref", "snapshot"); return s ? unseal<Reference>(s) : null; }
export async function lastSync() { return (await idbGet<string>("meta", "lastSync")) ?? null; }
