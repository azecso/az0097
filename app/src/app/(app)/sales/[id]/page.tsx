"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, StatusBadge, useAction, useLoad } from "@/components/ui";
import { Attach } from "@/components/attach";

interface Line { id: string; lineNo: number; productCode: string; productName: string; uom: string; qty: string; qtyBase: string; unitPrice: string; lineDiscount: string; lineTotal: string; delivered: string; returned: string }
interface Doc { id: string; customerId: string; docNo: string | null; draftRef: string; docDate: string; customerName: string; saleType: string; currency: string; exchangeRate: string; gross: string; discount: string; net: string; netBase: string; status: string; deliveryMode: string; cashAccountId: string | null;
  lines: Line[]; collected?: string; outstanding?: string; returned?: string; cogsBase?: string | null; profit?: { grossProfitBase: string; adjustedProfitBase: string; collectedRatio: string; linkedProfitBase: string } | null; terms: string | null }
export default function InvoiceView() {
  const { id } = useParams<{ id: string }>(); const router = useRouter(); const me = useMe();
  const { data: d, reload, err } = useLoad<Doc | null>(`/api/sales-invoices/${id}`, null); const { msg, busy, run } = useAction(reload);
  const [reason, setReason] = useState(""); const [ret, setRet] = useState<Record<string, string>>({}); const [dq, setDq] = useState<Record<string, string>>({}); const [pay, setPay] = useState("");
  const cash = useLoad<{ id: string; name: string; currency: string }[]>("/api/cash-accounts", []).data; const [acct, setAcct] = useState("");
  if (!d) return <p>{err || "جارٍ التحميل…"}</p>;
  const posted = d.status === "POSTED"; const canProfit = can(me, "report:view");
  return (<>
    <h1>فاتورة بيع <span className="num">{d.docNo ?? d.draftRef}</span> <StatusBadge s={d.status} /></h1>
    <div className="card grid">
      <div><div className="label">العميل</div>{d.customerName}</div><div><div className="label">التاريخ</div><span className="num">{d.docDate}</span></div>
      <div><div className="label">النوع</div>{d.saleType === "CASH" ? "نقدي" : "آجل"} — {d.deliveryMode === "WITH_INVOICE" ? "تسليم مع الفاتورة" : "تسليم منفصل"}</div>
      <div><div className="label">الإجمالي</div><span className="num">{money(d.gross)} {d.currency}</span></div>
      {Number(d.discount) > 0 && <div><div className="label">الخصم</div><span className="num">{money(d.discount)}</span></div>}
      <div><div className="label">الصافي</div><strong className="num">{money(d.net)} {d.currency}</strong></div>
      {d.currency !== "IQD" && <div><div className="label">سعر الصرف المثبّت</div><span className="num">{money(d.exchangeRate)}</span></div>}
      {d.outstanding !== undefined && <><div><div className="label">المحصّل</div><span className="num">{money(d.collected)}</span></div><div><div className="label">المتبقي</div><strong className="num">{money(d.outstanding)} {d.currency}</strong></div></>}
      {canProfit && d.profit && <><div><div className="label">إجمالي الربح</div><span className="num">{money(d.profit.grossProfitBase)} IQD</span></div>
        <div><div className="label">الربح المرتبط بالتحصيل (مؤشر)</div><span className="num">{money(d.profit.linkedProfitBase)} IQD</span></div></>}
    </div>
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>#</th><th>المادة</th><th>الكمية</th><th>السعر</th><th>الخصم</th><th>الإجمالي</th>{posted && <><th>المسلّم</th><th>المرتجع</th></>}</tr></thead>
      <tbody>{d.lines.map((l) => <tr key={l.id}><td>{l.lineNo}</td><td>{l.productCode} — {l.productName}</td><td><span className="num">{money(l.qty)} {l.uom}</span></td><td><span className="num">{money(l.unitPrice)}</span></td><td><span className="num">{money(l.lineDiscount)}</span></td><td><span className="num">{money(l.lineTotal)}</span></td>
        {posted && <><td><span className="num">{money(l.delivered)}</span> / <span className="num">{money(l.qtyBase)}</span></td><td><span className="num">{money(l.returned)}</span></td></>}</tr>)}</tbody></table></div>
    <MsgBox msg={msg} />
    <p style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
      {d.status === "DRAFT" && can(me, "sales:approve") && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/sales-invoices/${id}/post`, { method: "POST" }), "تم الترحيل وإصدار الرقم النهائي")}>ترحيل</button>}
      <a href={`/print/sales-invoice/${id}`} target="_blank" rel="noreferrer"><button>طباعة / PDF</button></a>
      {d.status === "DRAFT" && can(me, "sales:edit_draft") && <Link href={`/sales/new?edit=${id}`}><button>✏️ تعديل</button></Link>}
      {d.status === "DRAFT" && can(me, "sales:edit_draft") && <button className="danger" disabled={busy} onClick={async () => { if (await run(() => api(`/api/sales-invoices/${id}`, { method: "DELETE" }), "حُذفت المسودة")) router.push("/sales"); }}>حذف المسودة</button>}
    </p>
    <Attach entityType="sales_invoice" entityId={id} label="مرفقات الفاتورة (صور/إيصالات)" />
    {posted && Number(d.outstanding) > 0 && can(me, "voucher:create") && <div className="card" style={{ marginTop: 12 }}><h2>تسجيل قبض على هذه الفاتورة</h2>
      <div className="row"><div><label>المبلغ</label><input value={pay} onChange={(e) => setPay(e.target.value)} inputMode="decimal" dir="ltr" /></div>
        <div><label>الاستلام في</label><select value={acct} onChange={(e) => setAcct(e.target.value)}><option value="">اختر…</option>{cash.filter((c) => c.currency === d.currency).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <button className="primary" disabled={busy || !pay || !acct} onClick={async () => {
          const r = await run(() => api<{ id: string }>("/api/customer-receipts", { method: "POST", body: { customerId: d.customerId, docDate: today(), cashAccountId: acct, currency: d.currency, amount: pay, allocations: [{ invoiceId: id, amount: pay }] } }), "حُفظ السند");
          if (r) await run(() => api(`/api/customer-receipts/${r.id}/post`, { method: "POST" }), "تم ترحيل سند القبض"); }}>قبض</button></div></div>}
    {posted && d.deliveryMode === "SEPARATE" && can(me, "sales:create") && <div className="card" style={{ marginTop: 12 }}><h2>سند تسليم</h2>
      {d.lines.map((l) => <div className="row" key={l.id}><div>{l.productName} (المتبقي {money(String(Number(l.qtyBase) - Number(l.delivered)))})</div><div><label>الكمية</label><input value={dq[l.id] ?? ""} onChange={(e) => setDq({ ...dq, [l.id]: e.target.value })} dir="ltr" inputMode="decimal" /></div></div>)}
      <button disabled={busy} onClick={async () => { const lines = d.lines.filter((l) => dq[l.id]).map((l) => ({ salesLineId: l.id, qtyBase: dq[l.id] })); const r = await run(() => api<{ id: string }>("/api/delivery-notes", { method: "POST", body: { invoiceId: id, docDate: today(), lines } }), "حُفظ السند");
        if (r) await run(() => api(`/api/delivery-notes/${r.id}/post`, { method: "POST" }), "تم التسليم وتسجيل التكلفة"); }}>إنشاء وترحيل التسليم</button></div>}
    {posted && can(me, "sales:create") && <div className="card" style={{ marginTop: 12 }}><h2>مرتجع من العميل</h2>
      <p>يعود المخزون إلى نفس الطبقات بتكلفة البيع الأصلية؛ يُخصم أولاً من المتبقي على العميل، والفائض رصيد دائن للعميل (أو استرداد نقدي).</p>
      {d.lines.map((l) => <div className="row" key={l.id}><div>{l.productName}</div><div><label>الكمية المرتجعة</label><input value={ret[l.id] ?? ""} onChange={(e) => setRet({ ...ret, [l.id]: e.target.value })} dir="ltr" inputMode="decimal" /></div></div>)}
      <div className="row"><div><label>السبب</label><input value={reason} onChange={(e) => setReason(e.target.value)} /></div></div>
      <button disabled={busy || reason.length < 3} onClick={async () => { const lines = d.lines.filter((l) => ret[l.id]).map((l) => ({ salesLineId: l.id, qtyBase: ret[l.id] }));
        const r = await run(() => api<{ id: string }>("/api/sales-returns", { method: "POST", body: { invoiceId: id, docDate: today(), reason, settlement: "REDUCE_RECEIVABLE", lines } }), "حُفظ المرتجع");
        if (r) await run(() => api(`/api/sales-returns/${r.id}/post`, { method: "POST" }), "تم ترحيل المرتجع"); }}>إنشاء وترحيل المرتجع</button></div>}
    {posted && can(me, "sales:cancel") && <div className="card" style={{ marginTop: 12 }}><h2>عكس الفاتورة</h2><p>يُنشأ قيد عكسي ويعود المخزون؛ لا يُحذف شيء.</p>
      <div className="row"><div><label>السبب</label><input value={reason} onChange={(e) => setReason(e.target.value)} /></div><button className="danger" disabled={busy || reason.length < 3} onClick={() => run(() => api(`/api/sales-invoices/${id}/reverse`, { method: "POST", body: { reason } }), "تم العكس")}>عكس</button>
        <button disabled={busy || reason.length < 3} title="يعكس الفاتورة ثم يفتح نسخة جديدة منها للتعديل" onClick={async () => { const r = await run(() => api(`/api/sales-invoices/${id}/reverse`, { method: "POST", body: { reason } }), "تم العكس — عدّل النسخة الجديدة وارفضها أو رحّلها"); if (r !== undefined) router.push(`/sales/new?copy=${id}`); }}>✏️ تصحيح (عكس + نسخة جديدة)</button></div></div>}
  </>);
}
