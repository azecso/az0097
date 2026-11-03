// Encrypted local vault. Everything sensitive written to IndexedDB (drafts, cached reference data) is AES-256-GCM sealed with a key
// derived from the user's local PIN (PBKDF2-SHA256, 310k iterations). The key lives only in memory; locking/closing the tab drops it.
// Honest limit: this protects data at rest (lost phone, copied profile), not against malware running on the unlocked device.
import { idbGet, idbPut, idbWipe } from "./idb";

export interface Sealed { iv: string; data: string }
interface VaultMeta { salt: string; check: Sealed; userId: string; createdAt: string; iterations: number }
const ITER = 310_000; let key: CryptoKey | null = null; const listeners = new Set<() => void>();
export const onVaultChange = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const emit = () => listeners.forEach((f) => f());

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array, iterations: number) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function seal(value: unknown, k = key): Promise<Sealed> {
  if (!k) throw new Error("VAULT_LOCKED");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(JSON.stringify(value)));
  return { iv: b64(iv), data: b64(data) };
}
export async function unseal<T>(s: Sealed, k = key): Promise<T> {
  if (!k) throw new Error("VAULT_LOCKED");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) as BufferSource }, k, unb64(s.data) as BufferSource);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export async function vaultStatus() {
  const m = await idbGet<VaultMeta>("meta", "vault");
  return { initialized: !!m, unlocked: key !== null, userId: m?.userId ?? null };
}
export function validPin(pin: string) { return /^\d{6,12}$/.test(pin); }

export async function setupVault(pin: string, userId: string) {
  if (!validPin(pin)) throw new Error("الرقم السري 6 إلى 12 رقماً");
  const salt = crypto.getRandomValues(new Uint8Array(16)); const k = await derive(pin, salt, ITER);
  await idbPut("meta", { salt: b64(salt), check: await seal("erp-vault-ok", k), userId, createdAt: new Date().toISOString(), iterations: ITER } satisfies VaultMeta, "vault");
  key = k; emit();
}
export async function unlockVault(pin: string) {
  const m = await idbGet<VaultMeta>("meta", "vault"); if (!m) throw new Error("NO_VAULT");
  const k = await derive(pin, unb64(m.salt), m.iterations);
  try { if ((await unseal<string>(m.check, k)) !== "erp-vault-ok") throw new Error(); } catch { throw new Error("الرقم السري غير صحيح"); }
  key = k; emit();
}
export function lockVault() { key = null; emit(); }
/** Logout / different user / "clear local data": removes every local draft, cached reference and the vault header. */
export async function wipeVault() { key = null; await idbWipe(); emit(); }
export const isUnlocked = () => key !== null;
