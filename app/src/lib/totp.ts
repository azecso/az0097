// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) implemented on node:crypto, plus AES-256-GCM sealing of the secret at rest.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function b32encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function b32decode(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const c of s.replace(/=+$/, "").toUpperCase()) { const i = B32.indexOf(c); if (i < 0) throw new Error("bad base32"); value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export const newSecret = () => b32encode(randomBytes(20));

export function hotp(secret: string, counter: number): string {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1]! & 15;
  const code = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(code % 1_000_000).padStart(6, "0");
}
export const stepOf = (ms = Date.now()) => Math.floor(ms / 30_000);
/** Returns the matching time-step (allowing ±1 for clock skew) or null. */
export function verifyTotp(secret: string, code: string, ms = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const s = stepOf(ms);
  for (const step of [s, s - 1, s + 1]) if (hotp(secret, step) === code) return step;
  return null;
}
export const otpauthUri = (secret: string, account: string, issuer = "ERP") => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;

function key() {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 16) { if (process.env.NODE_ENV === "production") throw new Error("APP_SECRET (>=16 chars) is required in production"); return createHash("sha256").update("dev-only-insecure-secret").digest(); }
  return createHash("sha256").update(s).digest();
}
export function seal(plain: string): string {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key(), iv), enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
export function unseal(sealed: string): string {
  const [iv, tag, enc] = sealed.split(".").map((x) => Buffer.from(x, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(), iv!); d.setAuthTag(tag!);
  return Buffer.concat([d.update(enc!), d.final()]).toString("utf8");
}
