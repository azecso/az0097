// Minimal promise wrapper over IndexedDB. Stores: meta (settings/vault header), ref (sealed reference data), docs (sealed offline documents).
const NAME = "erp-offline", VERSION = 1;
export type StoreName = "meta" | "ref" | "docs";

let dbp: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => { const db = r.result; db.createObjectStore("meta"); db.createObjectStore("ref"); db.createObjectStore("docs", { keyPath: "localId" }); };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => { const t = db.transaction(store, mode); const req = fn(t.objectStore(store)); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
export const idbGet = <T>(s: StoreName, k: string) => run<T | undefined>(s, "readonly", (o) => o.get(k) as IDBRequest<T | undefined>);
export const idbPut = (s: StoreName, v: unknown, k?: string) => run(s, "readwrite", (o) => (k === undefined ? o.put(v) : o.put(v, k)));
export const idbDel = (s: StoreName, k: string) => run(s, "readwrite", (o) => o.delete(k));
export const idbAll = <T>(s: StoreName) => run<T[]>(s, "readonly", (o) => o.getAll() as IDBRequest<T[]>);
export const idbClear = (s: StoreName) => run(s, "readwrite", (o) => o.clear());
export async function idbWipe() { for (const s of ["meta", "ref", "docs"] as StoreName[]) await idbClear(s); }
