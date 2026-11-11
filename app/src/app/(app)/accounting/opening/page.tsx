"use client";
import { useState } from "react";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, useAction, useLoad } from "@/components/ui";

interface Eq { rows: number; cash: string; inventory: string; customers: string; suppliers: string; capital: string; retainedEarnings: string; assets: string; liabilities: string; equity: string; difference: string }
interface Row { id: string; asOf: string; kind: string; currency: string; amount: string; qty: string | null; note: string | null; status: string; contact: string | null; cashAccount: string | null; product: string | null }
const K: Record<string, string> = { CAPITAL: "رأس المال", CASH: "نقد", INVENTORY_LAYER: "مخزون (طبقة)", CUSTOMER: "عميل", SUPPLIER: "مورد", RETAINED_EARNINGS: "أرباح محتجزة افتتاحية" };
export default function Opening() {
  const me = useMe(); const { data, reload } = useLoad<{ rows: Row[]; equation: Eq } | null>("/api/opening", null); const { msg, busy, run } = useAction(reload);
  const cash = useLoad<{ id: string; name: string; currency: string }[]>("/api/cash-accounts", []).data, contacts = useLoad<{ id: string; name: string; kind: string }[]>("/api/contacts", []).data, prods = useLoad<{ id: string; code: string; name: string }[]>("/api/products", []).data, locs = useLoad<{ id: string; name: string }[]>("/api/locations", []).data;
  const [kind, setKind] = useState("CASH");
  async function add(e: React.FormEvent<HTMLFormElement>) { e.preventDefault(); const f = new FormData(e.currentTarget);
    const g = (k: string) => String(f.get(k) ?? ""); const base: Record<string, unknown> = { kind, asOf: g("asOf"), amount: g("amount"), note: g("note") || null };
    if (kind === "CASH") Object.assign(base, { cashAccountId: g("cash"), fxRate: g("crate") || null });
    if (kind === "INVENTORY_LAYER") Object.assign(base, { productId: g("prod"), locationId: g("loc"), qtyBase: g("qty"), receivedAt: g("recv") });
    if (kind === "CUSTOMER" || kind === "SUPPLIER") Object.assign(base, { contactId: g("contact"), currency: g("cur"), fxRate: g("rate") || null });
    await run(() => api("/api/opening", { method: "POST", body: base }), "أُضيف البند"); }
  const eq = data?.equation; const bal = eq && Number(eq.difference) === 0;
  return (<>
    <h1>الأرصدة الافتتاحية</h1>
    <p>أصول (نقد + مخزون بطبقاته المؤرخة + عملاء) − التزامات (موردون) = حقوق ملكية (رأس المال + أرباح محتجزة موثقة). إن وُجد فرق <strong>يُعرض ويُمنع الاعتماد</strong> ولا يُختلق قيد غير مفسَّر. تُعتمد مرة واحدة فقط.</p>
    {eq && <div className="grid"><div className="card stat"><div className="label">الأصول</div><div className="value"><span className="num">{money(eq.assets)}</span></div><small>نقد {money(eq.cash)} • مخزون {money(eq.inventory)} • عملاء {money(eq.customers)}</small></div>
      <div className="card stat"><div className="label">الالتزامات</div><div className="value"><span className="num">{money(eq.liabilities)}</span></div></div>
      <div className="card stat"><div className="label">حقوق الملكية</div><div className="value"><span className="num">{money(eq.equity)}</span></div></div>
      <div className="card stat"><div className="label">الفرق</div><div className="value"><span className="num">{money(eq.difference)}</span></div><span className="badge">{bal ? "✔ متوازنة" : "⚠ غير متوازنة"}</span></div></div>}
    {can(me, "opening_balance:create") && <form className="card" onSubmit={add} style={{ display: "grid", gap: 12, marginTop: 12 }}>
      <div className="row"><div><label htmlFor="k">النوع</label><select id="k" value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(K).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div><label htmlFor="d">بتاريخ</label><input id="d" name="asOf" type="date" defaultValue={today()} /></div>
        <div><label htmlFor="a">{kind === "INVENTORY_LAYER" ? "إجمالي تكلفة الطبقة (IQD)" : "المبلغ"}</label><input id="a" name="amount" required dir="ltr" inputMode="decimal" /></div></div>
      <div className="row">
        {kind === "CASH" && <div><label htmlFor="c">الحساب</label><select id="c" name="cash">{cash.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}</select></div>}
        {kind === "CASH" && <div><label htmlFor="cr">سعر الصرف (لصندوق الدولار: دينار لكل 1$)</label><input id="cr" name="crate" dir="ltr" inputMode="decimal" /></div>}
        {kind === "INVENTORY_LAYER" && <><div><label htmlFor="p">المادة</label><select id="p" name="prod">{prods.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}</select></div><div><label htmlFor="l">الموقع</label><select id="l" name="loc">{locs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
          <div><label htmlFor="q">الكمية (أساسية)</label><input id="q" name="qty" dir="ltr" inputMode="decimal" required /></div><div><label htmlFor="rv">تاريخ استلام الطبقة (FIFO)</label><input id="rv" name="recv" type="date" required /></div></>}
        {(kind === "CUSTOMER" || kind === "SUPPLIER") && <><div><label htmlFor="ct">الجهة</label><select id="ct" name="contact">{contacts.filter((c) => kind === "CUSTOMER" ? c.kind !== "SUPPLIER" : c.kind !== "CUSTOMER").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div><label htmlFor="cu">العملة</label><select id="cu" name="cur"><option>IQD</option><option>USD</option></select></div><div><label htmlFor="r">سعر الصرف (للدولار)</label><input id="r" name="rate" dir="ltr" /></div></>}
        <div><label htmlFor="n">{kind === "RETAINED_EARNINGS" ? "التوثيق (إلزامي)" : "ملاحظة"}</label><input id="n" name="note" required={kind === "RETAINED_EARNINGS"} /></div></div>
      <button className="primary" disabled={busy}>إضافة بند</button></form>}
    <MsgBox msg={msg} />
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>النوع</th><th>التفصيل</th><th>المبلغ</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{data?.rows.map((r) => <tr key={r.id}><td>{K[r.kind]}</td><td>{r.contact ?? r.cashAccount ?? r.product ?? r.note ?? "—"}{r.qty ? ` × ${money(r.qty)}` : ""}</td><td><span className="num">{money(r.amount)} {r.currency}</span></td><td>{r.status === "POSTED" ? "معتمد" : "مسودة"}</td>
        <td>{r.status === "DRAFT" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/opening/${r.id}`, { method: "DELETE" }), "حُذف")}>حذف</button>}</td></tr>)}
        {!data?.rows.length && <tr><td colSpan={5}>لا توجد بنود</td></tr>}</tbody></table></div>
    {me.user.isOwner && eq && eq.rows > 0 && <p style={{ marginTop: 12 }}><button className="primary" disabled={busy || !bal} onClick={() => run(() => api("/api/opening/post", { method: "POST" }), "اعتُمدت الأرصدة الافتتاحية وأُنشئ قيدها")}>اعتماد الأرصدة الافتتاحية (للمالك — مرة واحدة)</button></p>}
  </>);
}
