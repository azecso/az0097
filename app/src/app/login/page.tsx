"use client";
import { useState } from "react";
import { api, setCsrf } from "@/lib/client";

export default function Login() {
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setErr("");
    const f = new FormData(e.currentTarget);
    try { const r = await api<{ csrf: string }>("/api/auth/login", { method: "POST", body: { username: String(f.get("username")), password: String(f.get("password")) } }); setCsrf(r.csrf); window.location.href = "/"; }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  return (
    <main className="login"><form className="card" onSubmit={submit} style={{ display: "grid", gap: 12 }}>
      <h1>تسجيل الدخول</h1>
      <div><label htmlFor="u">اسم المستخدم</label><input id="u" name="username" autoComplete="username" required dir="ltr" /></div>
      <div><label htmlFor="p">كلمة المرور</label><input id="p" name="password" type="password" autoComplete="current-password" required dir="ltr" /></div>
      {err && <div className="msg err" role="alert">{err}</div>}
      <button className="primary" disabled={busy}>{busy ? "جارٍ الدخول…" : "دخول"}</button>
    </form></main>
  );
}
