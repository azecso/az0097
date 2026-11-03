"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";

interface U { id: string; username: string; displayName: string; isOwner: boolean; status: string; version: number }
interface Cat { resource: string; action: string; ownerOnly: boolean }
const ACTIONS = ["view", "create", "edit_draft", "approve", "cancel", "print", "export"] as const;
const AR: Record<string, string> = { view: "عرض", create: "إنشاء", edit_draft: "تعديل مسودة", approve: "اعتماد", cancel: "إلغاء", print: "طباعة", export: "تصدير" };
const RES: Record<string, string> = { company: "الشركة", users: "المستخدمون", contacts: "العملاء والموردون", products: "المواد", fx_rate: "سعر الصرف", purchase: "المشتريات", sales: "المبيعات",
  voucher: "السندات", stock_transfer: "تحويل المخزون", inventory_count: "الجرد", expense: "المصاريف", payroll: "الرواتب", capital: "رأس المال", capital_withdrawal: "سحب رأس المال",
  personal: "السحب الشخصي والذمم", opening_balance: "الأرصدة الافتتاحية", profit_settlement: "تسوية الأرباح", profit_payout: "دفعات الأرباح", period_close: "إقفال الفترات",
  journal: "القيود", audit: "سجل التدقيق", backup: "النسخ الاحتياطي", report: "التقارير" };

export default function Users() {
  const [users, setUsers] = useState<U[]>([]); const [sel, setSel] = useState<U | null>(null); const [cat, setCat] = useState<Cat[]>([]); const [granted, setGranted] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ t: "ok" | "err"; m: string } | null>(null);
  const load = () => api<U[]>("/api/users").then(setUsers).catch((e) => setMsg({ t: "err", m: e.message }));
  useEffect(() => { void load(); }, []);
  async function open(u: U) {
    setSel(u); setMsg(null);
    const r = await api<{ granted: { resource: string; action: string }[]; catalog: Cat[] }>(`/api/users/${u.id}/permissions`);
    setCat(r.catalog); setGranted(new Set(r.granted.map((g) => `${g.resource}:${g.action}`)));
  }
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setMsg(null);
    try { await api("/api/users", { method: "POST", body: { username: String(f.get("username")).toLowerCase(), displayName: String(f.get("displayName")), password: String(f.get("password")) } }); (e.target as HTMLFormElement).reset(); setMsg({ t: "ok", m: "تم إنشاء المحاسب بالصلاحيات الافتراضية" }); await load(); }
    catch (x) { setMsg({ t: "err", m: (x as Error).message }); }
  }
  async function savePerms() {
    try { await api(`/api/users/${sel!.id}/permissions`, { method: "PUT", body: { permissions: [...granted].map((k) => { const [resource, action] = k.split(":"); return { resource, action }; }) } }); setMsg({ t: "ok", m: "تم حفظ الصلاحيات" }); }
    catch (x) { setMsg({ t: "err", m: (x as Error).message }); }
  }
  async function toggleStatus(u: U) {
    try { await api(`/api/users/${u.id}`, { method: "PATCH", body: { status: u.status === "ACTIVE" ? "DISABLED" : "ACTIVE", version: u.version } }); await load(); } catch (x) { setMsg({ t: "err", m: (x as Error).message }); }
  }
  const resources = [...new Set(cat.map((c) => c.resource))];
  return (<>
    <h1>المستخدمون والصلاحيات</h1>
    <form className="card row" onSubmit={create}>
      <div><label htmlFor="un">اسم المستخدم</label><input id="un" name="username" required dir="ltr" pattern="[a-z0-9._\-]{3,64}" /></div>
      <div><label htmlFor="dn">الاسم</label><input id="dn" name="displayName" required /></div>
      <div><label htmlFor="pw">كلمة مرور (12 حرفاً فأكثر)</label><input id="pw" name="password" type="password" required minLength={12} dir="ltr" autoComplete="new-password" /></div>
      <button className="primary">إضافة محاسب</button></form>
    {msg && <div className={`msg ${msg.t}`} role="status">{msg.m}</div>}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>المستخدم</th><th>الدور</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{users.map((u) => <tr key={u.id}><td>{u.displayName} <span className="num">({u.username})</span></td><td>{u.isOwner ? "المالك" : "محاسب"}</td><td>{u.status === "ACTIVE" ? "نشط" : "معطّل"}</td>
        <td>{!u.isOwner && <><button onClick={() => open(u)}>الصلاحيات</button> <button className="danger" onClick={() => toggleStatus(u)}>{u.status === "ACTIVE" ? "تعطيل" : "تفعيل"}</button></>}</td></tr>)}</tbody></table></div>
    {sel && <div className="card" style={{ marginTop: 12, overflowX: "auto" }}><h2>صلاحيات {sel.displayName}</h2>
      <p>الصلاحيات المقفلة 🔒 للمالك حصراً ولا يمكن منحها لأي مستخدم آخر (يفرضها الخادم وقاعدة البيانات).</p>
      <table><thead><tr><th>المورد</th>{ACTIONS.map((a) => <th key={a}>{AR[a]}</th>)}</tr></thead>
        <tbody>{resources.map((r) => <tr key={r}><td>{RES[r] ?? r}</td>{ACTIONS.map((a) => { const c = cat.find((x) => x.resource === r && x.action === a); const k = `${r}:${a}`;
          return <td key={a}>{!c ? "" : c.ownerOnly ? <span title="للمالك فقط">🔒</span> : <input type="checkbox" aria-label={`${RES[r] ?? r} ${AR[a]}`} style={{ width: 24, minHeight: 24 }} checked={granted.has(k)}
            onChange={(e) => setGranted((g) => { const n = new Set(g); e.target.checked ? n.add(k) : n.delete(k); return n; })} />}</td>; })}</tr>)}</tbody></table>
      <button className="primary" onClick={savePerms} style={{ marginTop: 12 }}>حفظ الصلاحيات</button></div>}
  </>);
}
