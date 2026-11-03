"use client";
let csrf = "";
export const setCsrf = (t: string) => { csrf = t; };
export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const res = await fetch(path, { method, credentials: "same-origin", headers: { "content-type": "application/json", ...(method !== "GET" ? { "x-csrf-token": csrf } : {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "ERROR", data?.error?.message ?? "حدث خطأ");
  return data as T;
}
export const fmt = (s: string | number) => String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
