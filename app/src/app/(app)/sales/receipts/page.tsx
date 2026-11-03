"use client";
import { useState } from "react";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { createDraft, useRefList } from "@/lib/offline/use";
import { MsgBox, StatusBadge, useAction, useLoad } from "@/components/ui";

interface R { id: string; draftRef: string; docNo: string | null; docDate: string; customerName: string; kind: string; cashAccount: string | null; currency: string; amount: string; fxDiffBase: string; status: string; autoForInvoice: string | null }
interface Ag { id: string; docNo: string; customer: string; customerId: string; currency: string; outstanding: string; dueDate: string | null; daysOverdue: number; bucket: string }
interface Cust { id: string; name: string } interface Cash { id: string; name: string; currency: string }
export default function Receipts() {
  const me = useMe(); const list = useLoad<R[]>("/api/customer-receipts", []); const aging = useLoad<Ag[]>("/api/reports/receivables", []);
  const cust = useRefList<Cust & { kind?: string }>("contacts", "/api/contacts?kind=CUSTOMER", (c) => c.kind !== "SUPPLIER").data, cash = useRefList<Cash>("cashAccounts", "/api/cash-accounts").data;
  const { msg, busy, run, setMsg } = useAction(() => { void list.reload(); void aging.reload(); });
  const [customer, setCustomer] = useState(""); const [alloc, setAlloc] = useState<Record<string, string>>({}); const [reason, setReason] = useState("");
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const acct = cash.find((c) => c.id === String(f.get("cash")));
    const allocations = Object.entries(alloc).filter(([, v]) => v).map(([invoiceId, amount]) => ({ invoiceId, amount }));
    const r = await run(() => createDraft({ entityType: "customer_receipt", endpoint: "/api/customer-receipts", title: "سند قبض (أوفلاين)", payload: { customerId: customer, docDate: String(f.get("date")), cashAccountId: acct!.id, currency: acct!.currency, exchangeRate: acct!.currency === "IQD" ? null : String(f.get("rate") || "") || null, amount: String(f.get("amount")), allocations } }), "حُفظت مسودة السند");
    if (r?.mode === "queued") { setMsg({ t: "ok", m: "📴 حُفظت على جهازك مشفّرة وبانتظار المزامنة — ستُرسل تلقائياً عند عودة الاتصال (تابعها من «المزامنة»)." }); setAlloc({}); return; }
    setAlloc({});
  }
  const open = aging.data.filter((a) => a.customerId === customer);
  return (<>
    <h1>سندات القبض</h1>
    {can(me, "voucher:create") && <form className="card" onSubmit={create} style={{ display: "grid", gap: 12 }}>
      <div className="row">
        <div><label htmlFor="c">العميل</label><select id="c" value={customer} onChange={(e) => { setCustomer(e.target.value); setAlloc({}); }} required><option value="">اختر…</option>{cust.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><label htmlFor="d">التاريخ</label><input id="d" name="date" type="date" defaultValue={today()} /></div>
        <div><label htmlFor="ca">الاستلام في (الصندوق أو عهدة الشريك)</label><select id="ca" name="cash" required>{cash.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}</select></div>
        <div><label htmlFor="a">المبلغ</label><input id="a" name="amount" required dir="ltr" inputMode="decimal" /></div>
        <div><label htmlFor="r">سعر الصرف (للدولار)</label><input id="r" name="rate" dir="ltr" inputMode="decimal" /></div></div>
      <p>خصّص على فواتير العميل المفتوحة؛ ما لم يُخصَّص يُسجَّل رصيداً دائناً للعميل. القبض بيد الشريك يُسجَّل في «عهدة الشريك» ثم يُسلَّم للصندوق بسند تحويل دون تحصيل مضاعف.</p>
      <div className="cards-as-list"><table><thead><tr><th>الفاتورة</th><th>المتبقي</th><th>الاستحقاق</th><th>تخصيص</th></tr></thead>
        <tbody>{open.map((a) => <tr key={a.id}><td><span className="num">{a.docNo}</span></td><td><span className="num">{money(a.outstanding)} {a.currency}</span></td><td><span className="num">{a.dueDate ?? "—"}</span>{a.daysOverdue > 0 && <span className="badge"> متأخر {a.daysOverdue}</span>}</td>
          <td><input style={{ maxWidth: 140 }} dir="ltr" inputMode="decimal" value={alloc[a.id] ?? ""} onChange={(e) => setAlloc({ ...alloc, [a.id]: e.target.value })} /></td></tr>)}
          {customer && open.length === 0 && <tr><td colSpan={4}>لا توجد فواتير مفتوحة لهذا العميل</td></tr>}</tbody></table></div>
      <MsgBox msg={msg} /><button className="primary" disabled={busy}>حفظ كمسودة</button></form>}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>العميل</th><th>المبلغ</th><th>الصندوق</th><th>فرق الصرف</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{list.data.map((r) => <tr key={r.id}><td><span className="num">{r.docNo ?? r.draftRef}</span></td><td><span className="num">{r.docDate}</span></td><td>{r.customerName}</td><td><span className="num">{money(r.amount)} {r.currency}</span></td><td>{r.cashAccount ?? "رصيد دائن"}</td><td><span className="num">{money(r.fxDiffBase)}</span></td><td><StatusBadge s={r.status} /></td>
        <td><a href={`/print/receipt/${r.id}`} target="_blank" rel="noreferrer"><button>طباعة</button></a>{r.status === "DRAFT" && can(me, "voucher:approve") && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/customer-receipts/${r.id}/post`, { method: "POST" }), "تم الترحيل")}>ترحيل</button>}
          {r.status === "DRAFT" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/customer-receipts/${r.id}`, { method: "DELETE" }), "حُذفت المسودة")}>حذف</button>}
          {r.status === "POSTED" && !r.autoForInvoice && can(me, "voucher:cancel") && <><input aria-label="سبب العكس" placeholder="سبب العكس" style={{ maxWidth: 160 }} value={reason} onChange={(e) => setReason(e.target.value)} /><button className="danger" disabled={busy || reason.length < 3} onClick={() => run(() => api(`/api/customer-receipts/${r.id}/reverse`, { method: "POST", body: { reason } }), "تم العكس")}>عكس</button></>}</td></tr>)}
        {list.data.length === 0 && <tr><td colSpan={8}>لا توجد سندات</td></tr>}</tbody></table></div></>);
}
