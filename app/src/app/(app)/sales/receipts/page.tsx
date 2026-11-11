"use client";
import { FxRateField } from "@/components/fx-rate-field";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Decimal from "decimal.js";
import Link from "next/link";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { createDraft, useRefList } from "@/lib/offline/use";
import { MsgBox, StatusBadge, useAction, useLoad , ReverseBox } from "@/components/ui";

interface R { id: string; draftRef: string; docNo: string | null; docDate: string; customerName: string; kind: string; cashAccount: string | null; currency: string; amount: string; fxDiffBase: string; status: string; autoForInvoice: string | null }
interface Ag { id: string; docNo: string; customer: string; customerId: string; currency: string; outstanding: string; dueDate: string | null; daysOverdue: number; bucket: string }
interface Cust { id: string; name: string } interface Cash { id: string; name: string; currency: string }
function Inner() {
  const me = useMe(); const owner = me.user.isOwner; const router = useRouter(); const editId = useSearchParams().get("edit");
  const form = useLoad<any>(editId ? `/api/customer-receipts/${editId}/edit` : null, null).data; const list = useLoad<R[]>("/api/customer-receipts", []); const aging = useLoad<Ag[]>("/api/reports/receivables", []);
  const cust = useRefList<Cust & { kind?: string }>("contacts", "/api/contacts?kind=CUSTOMER", (c) => c.kind !== "SUPPLIER").data, cash = useRefList<Cash>("cashAccounts", "/api/cash-accounts").data;
  const { msg, busy, run, setMsg } = useAction(() => { void list.reload(); void aging.reload(); });
  const [customer, setCustomer] = useState(""); const [alloc, setAlloc] = useState<Record<string, string>>({}); const [reason, setReason] = useState("");
  const [kind, setKind] = useState<"CASH" | "CREDIT_APPLICATION">("CASH"); const [amt, setAmt] = useState(""); const [cashId, setCashId] = useState(""); const [manual, setManual] = useState(false);
  const [ext, setExt] = useState<Record<string, { on: boolean; amount: string; note: string }>>({});
  const editRows: Ag[] = form ? form.allocations.map((x: any) => ({ id: x.invoiceId, docNo: x.docNo, customer: "", customerId: form.customerId, currency: x.currency, outstanding: x.outstandingWithout, dueDate: x.dueDate, daysOverdue: 0, bucket: "" })) : [];
  const open = [...aging.data.filter((a) => a.customerId === customer && !editRows.some((e) => e.id === a.id)), ...(form && customer === form.customerId ? editRows : [])];
  const cashCur = cash.find((c) => c.id === (cashId || cash[0]?.id))?.currency; const curNow = kind === "CASH" ? cashCur : open[0]?.currency;
  const allocTotal = Object.values(alloc).reduce((t, v) => { try { return v ? t.plus(new Decimal(v)) : t; } catch { return t; } }, new Decimal(0));
  // Nothing is allocated automatically: the user picks the invoice(s) to collect on. The amount follows the allocations until it is typed by hand.
  const [amtTouched, setAmtTouched] = useState(false);
  const amountValue = amtTouched ? amt : (allocTotal.gt(0) ? allocTotal.toString() : "");
  const rest = kind === "CASH" && amountValue ? (() => { try { return new Decimal(amountValue).minus(allocTotal); } catch { return new Decimal(0); } })() : new Decimal(0);
  useEffect(() => { if (!form) return; setKind(form.kind); setCustomer(form.customerId); setCashId(form.cashAccountId ?? ""); setAmt(form.amount.replace(/\.?0+$/, "")); setAmtTouched(!form.allocations.reduce((t: Decimal, x: any) => t.plus(x.cash), new Decimal(0)).eq(new Decimal(form.amount))); setManual(true);   // the amount follows the allocations unless part of it is an unallocated credit
    setAlloc(Object.fromEntries(form.allocations.filter((x: any) => Number(x.cash) > 0).map((x: any) => [x.invoiceId, x.cash.replace(/\.?0+$/, "")])));
    setExt(Object.fromEntries(form.allocations.filter((x: any) => Number(x.external) > 0).map((x: any) => [x.invoiceId, { on: true, amount: "", note: x.note ?? "" }]))); }, [form]);
  const safeD = (v: string | undefined) => { try { return new Decimal(v || 0); } catch { return new Decimal(0); } };
  const extOf = (a: Ag) => (ext[a.id]?.on ? Decimal.max(0, safeD(a.outstanding).minus(safeD(alloc[a.id]))) : new Decimal(0));
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const acct = cash.find((c) => c.id === String(f.get("cash") ?? ""));
    const ids = new Set([...Object.keys(alloc).filter((k) => alloc[k]), ...open.filter((a) => extOf(a).gt(0)).map((a) => a.id)]);
    const allocations = [...ids].map((invoiceId) => ({ invoiceId, amount: alloc[invoiceId] || "0", externalAmount: extOf(open.find((a) => a.id === invoiceId)!).toString(), externalNote: ext[invoiceId]?.on ? ext[invoiceId]!.note : null }));
    const credit = kind === "CREDIT_APPLICATION";
    const payload = { customerId: customer, docDate: String(f.get("date")), kind, cashAccountId: credit ? null : acct!.id, currency: credit ? (open[0]?.currency ?? "IQD") : acct!.currency, exchangeRate: credit || acct!.currency === "IQD" ? null : String(f.get("rate") || "") || null, amount: credit ? allocTotal.toString() : amountValue, allocations };
    if (editId && form) { const u = await run(() => api(`/api/customer-receipts/${editId}/amend`, { method: "POST", body: { ...payload, version: form.version } }), "تم حفظ التعديل — بقي رقم السند نفسه"); if (u !== undefined) router.push("/sales/receipts"); return; }
    const r = await run(() => createDraft({ entityType: "customer_receipt", endpoint: "/api/customer-receipts", title: "سند قبض (أوفلاين)", payload }), "حُفظت مسودة السند");
    if (r?.mode === "queued") { setMsg({ t: "ok", m: "📴 حُفظت على جهازك مشفّرة وبانتظار المزامنة — ستُرسل تلقائياً عند عودة الاتصال (تابعها من «المزامنة»)." }); setAlloc({}); return; }
    setAlloc({}); setExt({}); setAmt(""); setAmtTouched(false);
  }
  const [showDel, setShowDel] = useState(false);
  return (<>
    <h1>{editId ? `تعديل سند القبض ${form?.docNo ?? ""}` : "سندات القبض"}</h1>{editId && <div className="msg">تعديل سند مرحّل: يبقى رقمه ويُعاد احتساب الصندوق والفواتير تلقائياً.</div>}
    {can(me, "voucher:create") && <form key={form?.id ?? "new"} className="card" onSubmit={create} style={{ display: "grid", gap: 12 }}>
      <div className="row">
        <div><label htmlFor="k">نوع السند</label><select id="k" value={kind} onChange={(e) => { setKind(e.target.value as "CASH" | "CREDIT_APPLICATION"); setAlloc({}); setExt({}); setManual(kind !== "CASH"); }}><option value="CASH">قبض نقدي</option><option value="CREDIT_APPLICATION">تسوية رصيد دائن على فواتير</option></select></div>
        <div><label htmlFor="c">العميل</label><select id="c" value={customer} onChange={(e) => { setCustomer(e.target.value); setAlloc({}); setExt({}); setAmt(""); setAmtTouched(false); setManual(false); }} required><option value="">اختر…</option>{cust.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><label htmlFor="d">التاريخ</label><input id="d" name="date" type="date" defaultValue={today()} /></div>
        {kind === "CASH" && <><div><label htmlFor="ca">الاستلام في (الصندوق أو عهدة الشريك)</label><select id="ca" name="cash" required value={cashId} onChange={(e) => setCashId(e.target.value)}>{cash.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}</select></div>
        <div><label htmlFor="a">المبلغ</label><input id="a" name="amount" required dir="ltr" inputMode="decimal" value={amountValue} onChange={(e) => { setAmt(e.target.value); setAmtTouched(true); }} /></div>
        <FxRateField /></>}</div>
      {kind === "CASH" ? <p>اختر العميل فتظهر فواتيره المفتوحة، ثم <strong>حدّد الفاتورة التي تقبض عليها</strong> واكتب المبلغ (أو اضغط «المتبقي كاملاً»). لا يُخصَّص شيء تلقائياً. للفاتورة التي أُخذ ربحها خارج النظام فعّل «بدون أرباح» واكتب مبلغ الربح الخارجي: يُغلق من الفاتورة ولا يدخل الصندوق ولا يُوزَّع مرة ثانية (نصفه لكل شريك). ما لم يُخصَّص يُسجَّل <strong>رصيداً دائناً</strong> للعميل ولا يخفض دينه ولا يُحتسب في الربح المرتبط بالتحصيل حتى تسوّيه على فواتير.{rest.gt(0) && <strong style={{ color: "var(--danger)" }}> ⚠ غير مخصَّص: {money(rest.toString())}</strong>}</p> : <p>استخدم رصيد العميل الدائن (دفعات غير مخصَّصة سابقاً) لسداد فواتيره: وزّع المبلغ أدناه على الفواتير؛ مجموع التخصيص = المبلغ المسوّى ({money(allocTotal.toString())}).</p>}<p> القبض بيد الشريك يُسجَّل في «عهدة الشريك» ثم يُسلَّم للصندوق بسند تحويل دون تحصيل مضاعف.</p>
      <div className="cards-as-list"><table><thead><tr><th>الفاتورة</th><th>المتبقي</th><th>الاستحقاق</th><th>تخصيص (مستحصل نقداً)</th>{owner && kind === "CASH" && <th>ربح موزَّع خارج النظام</th>}</tr></thead>
        <tbody>{open.map((a) => <tr key={a.id}><td><span className="num">{a.docNo}</span></td><td><span className="num">{money(a.outstanding)} {a.currency}</span></td><td><span className="num">{a.dueDate ?? "—"}</span>{a.daysOverdue > 0 && <span className="badge"> متأخر {a.daysOverdue}</span>}</td>
          <td><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><input aria-label={`المبلغ المقبوض على ${a.docNo}`} style={{ maxWidth: 140 }} dir="ltr" inputMode="decimal" value={alloc[a.id] ?? ""} onChange={(e) => { setManual(true); setAlloc({ ...alloc, [a.id]: e.target.value }); }} /><button type="button" onClick={() => { setManual(true); setAlloc({ ...alloc, [a.id]: a.outstanding }); }}>المتبقي كاملاً</button></div></td>
          {owner && kind === "CASH" && <td>{a.currency === "IQD" ? <><label style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" style={{ width: 22, minHeight: 22 }} checked={!!ext[a.id]?.on} onChange={(e) => setExt({ ...ext, [a.id]: { on: e.target.checked, amount: "", note: ext[a.id]?.note ?? "" } })} />بدون أرباح</label>
            {ext[a.id]?.on && <div style={{ display: "grid", gap: 4, marginTop: 4 }}><input aria-label="ملاحظة" placeholder="ملاحظة (اختيارية)" value={ext[a.id]?.note ?? ""} onChange={(e) => setExt({ ...ext, [a.id]: { ...ext[a.id]!, note: e.target.value } })} />
              <small>«تخصيص» = المبلغ المقبوض الفعلي. <strong>الباقي {money(extOf(a).toString())}</strong> يُسجَّل ربحاً موزَّعاً خارج النظام وتُغلق الفاتورة.</small></div>}</> : <small>بالدينار فقط</small>}</td>}</tr>)}
          {customer && open.length === 0 && <tr><td colSpan={5}>لا توجد فواتير مفتوحة لهذا العميل</td></tr>}</tbody></table></div>
      <MsgBox msg={msg} /><button className="primary" disabled={busy}>{editId ? "حفظ التعديل" : "حفظ كمسودة"}</button></form>}
    <label style={{ display: "inline-flex", gap: 6, alignItems: "center", margin: "4px 0" }}><input type="checkbox" checked={showDel} onChange={(e) => setShowDel(e.target.checked)} />إظهار المحذوفة</label>
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>العميل</th><th>المبلغ</th><th>الصندوق</th><th>فرق الصرف</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{list.data.filter((r) => showDel || r.status !== "REVERSED").map((r) => <tr key={r.id}><td><span className="num">{r.docNo ?? r.draftRef}</span></td><td><span className="num">{r.docDate}</span></td><td>{r.customerName}</td><td><span className="num">{money(r.amount)} {r.currency}</span></td><td>{r.cashAccount ?? "رصيد دائن"}</td><td><span className="num">{money(r.fxDiffBase)}</span></td><td><StatusBadge s={r.status} /></td>
        <td><a href={`/print/receipt/${r.id}`} target="_blank" rel="noreferrer"><button>طباعة</button></a>{r.status === "DRAFT" && can(me, "voucher:approve") && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/customer-receipts/${r.id}/post`, { method: "POST" }), "تم الترحيل")}>ترحيل</button>}
          {r.status === "DRAFT" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/customer-receipts/${r.id}`, { method: "DELETE" }), "حُذفت المسودة")}>حذف</button>}
          {r.status === "POSTED" && can(me, "voucher:cancel") && <Link href={`/sales/receipts?edit=${r.id}`}><button type="button">✏️ تعديل</button></Link>}
          {r.status === "POSTED" && !r.autoForInvoice && can(me, "voucher:cancel") && <ReverseBox label="حذف" busy={busy} onReverse={(reason) => run(() => api(`/api/customer-receipts/${r.id}/reverse`, { method: "POST", body: { reason } }), "تم العكس")} />}</td></tr>)}
        {list.data.length === 0 && <tr><td colSpan={8}>لا توجد سندات</td></tr>}</tbody></table></div></>);
}
export default function Receipts() { return <Suspense fallback={null}><Inner /></Suspense>; }
