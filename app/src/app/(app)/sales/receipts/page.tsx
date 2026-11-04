"use client";
import { useEffect, useState } from "react";
import Decimal from "decimal.js";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { createDraft, useRefList } from "@/lib/offline/use";
import { MsgBox, StatusBadge, useAction, useLoad , ReverseBox } from "@/components/ui";

interface R { id: string; draftRef: string; docNo: string | null; docDate: string; customerName: string; kind: string; cashAccount: string | null; currency: string; amount: string; fxDiffBase: string; status: string; autoForInvoice: string | null }
interface Ag { id: string; docNo: string; customer: string; customerId: string; currency: string; outstanding: string; dueDate: string | null; daysOverdue: number; bucket: string }
interface Cust { id: string; name: string } interface Cash { id: string; name: string; currency: string }
export default function Receipts() {
  const me = useMe(); const list = useLoad<R[]>("/api/customer-receipts", []); const aging = useLoad<Ag[]>("/api/reports/receivables", []);
  const cust = useRefList<Cust & { kind?: string }>("contacts", "/api/contacts?kind=CUSTOMER", (c) => c.kind !== "SUPPLIER").data, cash = useRefList<Cash>("cashAccounts", "/api/cash-accounts").data;
  const { msg, busy, run, setMsg } = useAction(() => { void list.reload(); void aging.reload(); });
  const [customer, setCustomer] = useState(""); const [alloc, setAlloc] = useState<Record<string, string>>({}); const [reason, setReason] = useState("");
  const [kind, setKind] = useState<"CASH" | "CREDIT_APPLICATION">("CASH"); const [amt, setAmt] = useState(""); const [cashId, setCashId] = useState(""); const [manual, setManual] = useState(false);
  const open = aging.data.filter((a) => a.customerId === customer);
  const cashCur = cash.find((c) => c.id === (cashId || cash[0]?.id))?.currency; const curNow = kind === "CASH" ? cashCur : open[0]?.currency;
  const allocTotal = Object.values(alloc).reduce((t, v) => { try { return v ? t.plus(new Decimal(v)) : t; } catch { return t; } }, new Decimal(0));
  // Oldest-due invoices first (the aging list is already ordered that way) until the entered amount is used up; the user can still edit any cell.
  useEffect(() => {
    if (manual || kind !== "CASH") return; let left: Decimal; try { left = amt ? new Decimal(amt) : new Decimal(0); } catch { return; }
    const next: Record<string, string> = {};
    for (const a of open) { if (left.lte(0)) break; if (curNow && a.currency !== curNow) continue; const out = new Decimal(a.outstanding); const take = Decimal.min(left, out); if (take.gt(0)) { next[a.id] = take.toString(); left = left.minus(take); } }
    setAlloc(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amt, customer, kind, cashCur, aging.data.length, manual]);
  const rest = kind === "CASH" && amt ? (() => { try { return new Decimal(amt).minus(allocTotal); } catch { return new Decimal(0); } })() : new Decimal(0);
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const acct = cash.find((c) => c.id === String(f.get("cash") ?? ""));
    const allocations = Object.entries(alloc).filter(([, v]) => v).map(([invoiceId, amount]) => ({ invoiceId, amount }));
    const credit = kind === "CREDIT_APPLICATION";
    const r = await run(() => createDraft({ entityType: "customer_receipt", endpoint: "/api/customer-receipts", title: "سند قبض (أوفلاين)", payload: { customerId: customer, docDate: String(f.get("date")), kind, cashAccountId: credit ? null : acct!.id, currency: credit ? (open[0]?.currency ?? "IQD") : acct!.currency, exchangeRate: credit || acct!.currency === "IQD" ? null : String(f.get("rate") || "") || null, amount: credit ? allocTotal.toString() : amt, allocations } }), "حُفظت مسودة السند");
    if (r?.mode === "queued") { setMsg({ t: "ok", m: "📴 حُفظت على جهازك مشفّرة وبانتظار المزامنة — ستُرسل تلقائياً عند عودة الاتصال (تابعها من «المزامنة»)." }); setAlloc({}); return; }
    setAlloc({});
  }
  return (<>
    <h1>سندات القبض</h1>
    {can(me, "voucher:create") && <form className="card" onSubmit={create} style={{ display: "grid", gap: 12 }}>
      <div className="row">
        <div><label htmlFor="k">نوع السند</label><select id="k" value={kind} onChange={(e) => { setKind(e.target.value as "CASH" | "CREDIT_APPLICATION"); setAlloc({}); setManual(kind !== "CASH"); }}><option value="CASH">قبض نقدي</option><option value="CREDIT_APPLICATION">تسوية رصيد دائن على فواتير</option></select></div>
        <div><label htmlFor="c">العميل</label><select id="c" value={customer} onChange={(e) => { setCustomer(e.target.value); setAlloc({}); setManual(false); }} required><option value="">اختر…</option>{cust.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><label htmlFor="d">التاريخ</label><input id="d" name="date" type="date" defaultValue={today()} /></div>
        {kind === "CASH" && <><div><label htmlFor="ca">الاستلام في (الصندوق أو عهدة الشريك)</label><select id="ca" name="cash" required value={cashId} onChange={(e) => setCashId(e.target.value)}>{cash.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}</select></div>
        <div><label htmlFor="a">المبلغ</label><input id="a" name="amount" required dir="ltr" inputMode="decimal" value={amt} onChange={(e) => { setAmt(e.target.value); setManual(false); }} /></div>
        <div><label htmlFor="r">سعر الصرف (للدولار)</label><input id="r" name="rate" dir="ltr" inputMode="decimal" /></div></>}</div>
      {kind === "CASH" ? <p>يوزَّع المبلغ تلقائياً على أقدم الفواتير المفتوحة (يمكنك تعديل التوزيع). ما لم يُخصَّص يُسجَّل <strong>رصيداً دائناً</strong> للعميل ولا يخفض دينه ولا يُحتسب في الربح المرتبط بالتحصيل حتى تسوّيه على فواتير.{rest.gt(0) && <strong style={{ color: "var(--danger)" }}> ⚠ غير مخصَّص: {money(rest.toString())}</strong>}</p> : <p>استخدم رصيد العميل الدائن (دفعات غير مخصَّصة سابقاً) لسداد فواتيره: وزّع المبلغ أدناه على الفواتير؛ مجموع التخصيص = المبلغ المسوّى ({money(allocTotal.toString())}).</p>}<p> القبض بيد الشريك يُسجَّل في «عهدة الشريك» ثم يُسلَّم للصندوق بسند تحويل دون تحصيل مضاعف.</p>
      <div className="cards-as-list"><table><thead><tr><th>الفاتورة</th><th>المتبقي</th><th>الاستحقاق</th><th>تخصيص</th></tr></thead>
        <tbody>{open.map((a) => <tr key={a.id}><td><span className="num">{a.docNo}</span></td><td><span className="num">{money(a.outstanding)} {a.currency}</span></td><td><span className="num">{a.dueDate ?? "—"}</span>{a.daysOverdue > 0 && <span className="badge"> متأخر {a.daysOverdue}</span>}</td>
          <td><input style={{ maxWidth: 140 }} dir="ltr" inputMode="decimal" value={alloc[a.id] ?? ""} onChange={(e) => { setManual(true); setAlloc({ ...alloc, [a.id]: e.target.value }); }} /></td></tr>)}
          {customer && open.length === 0 && <tr><td colSpan={4}>لا توجد فواتير مفتوحة لهذا العميل</td></tr>}</tbody></table></div>
      <MsgBox msg={msg} /><button className="primary" disabled={busy}>حفظ كمسودة</button></form>}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>العميل</th><th>المبلغ</th><th>الصندوق</th><th>فرق الصرف</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{list.data.map((r) => <tr key={r.id}><td><span className="num">{r.docNo ?? r.draftRef}</span></td><td><span className="num">{r.docDate}</span></td><td>{r.customerName}</td><td><span className="num">{money(r.amount)} {r.currency}</span></td><td>{r.cashAccount ?? "رصيد دائن"}</td><td><span className="num">{money(r.fxDiffBase)}</span></td><td><StatusBadge s={r.status} /></td>
        <td><a href={`/print/receipt/${r.id}`} target="_blank" rel="noreferrer"><button>طباعة</button></a>{r.status === "DRAFT" && can(me, "voucher:approve") && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/customer-receipts/${r.id}/post`, { method: "POST" }), "تم الترحيل")}>ترحيل</button>}
          {r.status === "DRAFT" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/customer-receipts/${r.id}`, { method: "DELETE" }), "حُذفت المسودة")}>حذف</button>}
          {r.status === "POSTED" && !r.autoForInvoice && can(me, "voucher:cancel") && <ReverseBox busy={busy} onReverse={(reason) => run(() => api(`/api/customer-receipts/${r.id}/reverse`, { method: "POST", body: { reason } }), "تم العكس")} />}</td></tr>)}
        {list.data.length === 0 && <tr><td colSpan={8}>لا توجد سندات</td></tr>}</tbody></table></div></>);
}
