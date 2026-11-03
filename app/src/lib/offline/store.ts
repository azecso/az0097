import { idbAll, idbDel, idbGet, idbPut } from "./idb";
import { seal, unseal, type Sealed } from "./vault";

export type OpState = "QUEUED" | "DONE" | "CONFLICT" | "REJECTED";
export interface QueuedOp { operationId: string; idempotencyKey: string; op: "CREATE_DRAFT" | "UPDATE_DRAFT" | "SUBMIT_FOR_POSTING"; baseVersion: number | null; payload: Sealed; clientCreatedAt: string; state: OpState; code?: string; message?: string }
export interface LocalDoc { localId: string; entityType: string; createdAt: string; title: Sealed; ops: QueuedOp[]; serverId?: string; draftRef?: string; docNo?: string; version?: number }
export type DocStatus = "PENDING" | "SYNCED" | "POSTED" | "CONFLICT" | "REJECTED";

const listeners = new Set<() => void>();
export const onStoreChange = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const emitStore = () => listeners.forEach((f) => f());

export function statusOf(d: LocalDoc): DocStatus {
  const bad = [...d.ops].reverse().find((o) => o.state === "CONFLICT" || o.state === "REJECTED");
  if (bad) return bad.state === "CONFLICT" ? "CONFLICT" : "REJECTED";
  if (d.ops.some((o) => o.state === "QUEUED")) return "PENDING";
  return d.docNo ? "POSTED" : "SYNCED";
}
export const newId = () => crypto.randomUUID();

export async function enqueueCreate(entityType: string, payload: unknown, title: string): Promise<string> {
  const localId = newId(), now = new Date().toISOString();
  const doc: LocalDoc = { localId, entityType, createdAt: now, title: await seal({ title }), ops: [{ operationId: newId(), idempotencyKey: `${localId}:create`, op: "CREATE_DRAFT", baseVersion: null, payload: await seal(payload), clientCreatedAt: now, state: "QUEUED" }] };
  await idbPut("docs", doc); emitStore(); return localId;
}
export async function enqueueSubmit(localId: string): Promise<void> {
  const d = await idbGet<LocalDoc>("docs", localId); if (!d) return;
  if (d.ops.some((o) => o.op === "SUBMIT_FOR_POSTING" && o.state !== "REJECTED" && o.state !== "CONFLICT")) return;
  const n = d.ops.filter((o) => o.op === "SUBMIT_FOR_POSTING").length;
  d.ops.push({ operationId: newId(), idempotencyKey: `${localId}:submit:${n}`, op: "SUBMIT_FOR_POSTING", baseVersion: null, payload: await seal({}), clientCreatedAt: new Date().toISOString(), state: "QUEUED" });
  await idbPut("docs", d); emitStore();
}
/** User chose to retry a conflicted/rejected submit: re-queue a fresh operation (the old one stays in the history). */
export async function retryOp(localId: string): Promise<void> {
  const d = await idbGet<LocalDoc>("docs", localId); if (!d) return;
  const last = [...d.ops].reverse().find((o) => o.state === "CONFLICT" || o.state === "REJECTED"); if (!last) return;
  const n = d.ops.length;
  d.ops.push({ ...last, operationId: newId(), idempotencyKey: `${localId}:retry:${n}`, clientCreatedAt: new Date().toISOString(), state: "QUEUED", code: undefined, message: undefined });
  last.state = "DONE"; last.message = "أُعيدت المحاولة"; await idbPut("docs", d); emitStore();
}
export async function discardDoc(localId: string) { await idbDel("docs", localId); emitStore(); }
export async function listDocs(): Promise<LocalDoc[]> { return (await idbAll<LocalDoc>("docs")).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
export async function putDoc(d: LocalDoc) { await idbPut("docs", d); emitStore(); }
export async function titleOf(d: LocalDoc) { try { return (await unseal<{ title: string }>(d.title)).title; } catch { return "🔒 (افتح القفل)"; } }
export async function payloadOf(op: QueuedOp) { return unseal<Record<string, unknown>>(op.payload); }

export async function exportAll(): Promise<string> {
  const docs = await listDocs(); const out = [];
  for (const d of docs) out.push({ ...d, title: await titleOf(d), ops: await Promise.all(d.ops.map(async (o) => ({ ...o, payload: await payloadOf(o) }))) });
  return JSON.stringify({ exportedAt: new Date().toISOString(), note: "مسودات غير مزامنة — احتفظ بها في مكان آمن", docs: out }, null, 2);
}
