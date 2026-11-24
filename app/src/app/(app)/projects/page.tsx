"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, money } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, useAction, useLoad } from "@/components/ui";

interface P { id: string; name: string; notes: string | null; status: string; totals: { currency: string; spent: string; refunded: string; net: string }[] }
export default function Projects() {
  const me = useMe(); const router = useRouter(); const list = useLoad<P[]>("/api/projects", []); const { msg, busy, run } = useAction(list.reload);
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const r = await run(() => api<{ id: string }>("/api/projects", { method: "POST", body: { name: String(f.get("name")), notes: String(f.get("notes") ?? "") || null } }), "تم إنشاء المشروع");
    if (r) router.push(`/projects/${r.id}`);
  }
  return (<>
    <h1>المشاريع</h1>
    <p>افتح مشروعاً وسجّل داخله ما صُرف عليه (يخرج من الصندوق فوراً) وما رجع منه. لا يدخل أرباح الشراكة ولا يُنقصها؛ يظهر هنا صافي تكلفة كل مشروع.</p>
    {can(me, "expense:create") && <form className="card" onSubmit={create} style={{ display: "grid", gap: 12 }}><div className="row">
      <div><label htmlFor="n">اسم المشروع</label><input id="n" name="name" required minLength={2} /></div>
      <div><label htmlFor="o">ملاحظات</label><input id="o" name="notes" /></div></div>
      <MsgBox msg={msg} /><button className="primary" disabled={busy}>إنشاء مشروع</button></form>}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>المشروع</th><th>المصروف</th><th>المسترجع</th><th>صافي التكلفة</th><th></th></tr></thead>
      <tbody>{list.data.map((p) => <tr key={p.id}><td><Link href={`/projects/${p.id}`}><b>{p.name}</b></Link>{p.notes ? <small> — {p.notes}</small> : null}</td>
        <td>{p.totals.length ? p.totals.map((t) => <div key={t.currency}><span className="num">{money(t.spent)} {t.currency}</span></div>) : "—"}</td>
        <td>{p.totals.length ? p.totals.map((t) => <div key={t.currency}><span className="num">{money(t.refunded)} {t.currency}</span></div>) : "—"}</td>
        <td>{p.totals.length ? p.totals.map((t) => <div key={t.currency}><b className="num">{money(t.net)} {t.currency}</b></div>) : "—"}</td>
        <td><Link href={`/projects/${p.id}`}><button type="button">فتح</button></Link></td></tr>)}
        {list.data.length === 0 && <tr><td colSpan={5}>لا توجد مشاريع</td></tr>}</tbody></table></div></>);
}
