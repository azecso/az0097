"use client";
let csrf = "";
export const setCsrf = (t: string) => { csrf = t; };
export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30000);       // never hang forever on a sleeping/unreachable server
  let res: Response;
  try { res = await fetch(path, { method, credentials: "same-origin", signal: ctl.signal, headers: { "content-type": "application/json", ...(method !== "GET" ? { "x-csrf-token": csrf } : {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) }); }
  catch (e) { if ((e as Error).name === "AbortError") throw new ApiError(0, "TIMEOUT", "انتهت مهلة الاتصال بالخادم (30 ثانية)"); throw e; }
  finally { clearTimeout(timer); }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "ERROR", data?.error?.message ?? "حدث خطأ");
  return data as T;
}
export const fmt = (s: string | number) => String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** "1450000.0000" -> "1,450,000"; keeps real decimals ("12.50"), drops trailing zeros. */
export function money(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const [i, f = ""] = String(v).split(".");
  const frac = f.replace(/0+$/, "");
  return (i ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? "." + frac : "");
}
export const today = () => new Date().toISOString().slice(0, 10);
