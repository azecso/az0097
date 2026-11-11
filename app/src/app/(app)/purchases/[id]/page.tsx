"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, StatusBadge, useAction, useLoad } from "@/components/ui";
import { Attach } from "@/components/attach";
import { PayPurchaseDialog } from "@/components/pay-dialog";

interface Line { id: string; lineNo: number; productCode: string; productName: string; uom: string; qty: string; qtyBase: string; unitPrice: string; lineTotal: string; lineTotalBase: string; profitClass?: string }
interface Doc { id: string; docNo: string | null; draftRef: string; docDate: string; supplierName: string; paymentType: string; currency: string; exchangeRate: string; total: string; totalBase: string; status: string; version: number; lines: Line[]; charges: { kind: string; description: string | null; amount: string; capitalize: boolean }[]; paid?: string; returned?: string; outstanding?: string; supplierInvoiceNo: string | null; cashAccountId: string | null }
export default function PurchaseView() {
  const { id } = useParams<{ id: string }>(); const router = useRouter(); const me = useMe();
  const { data: d, reload, err } = useLoad<Doc | null>(`/api/purchases/${id}`, null); const { msg, busy, run, setMsg } = useAction(reload); const [payOpen, setPayOpen] = useState(false);
  const [reason, setReason] = useState(""); const [ret, setRet] = useState<Record<string, string>>({}); const [exc, setExc] = useState("");
  if (!d) return <p>{err || "جارٍ التحميل…"}</p>;
  const posted = d.status === "POSTED";
  return (<>
    <h1>فاتورة شراء <span className="num">{d.docNo ?? d.draftRef}</span> <StatusBadge s={d.status} /></h1>
    <div className="card grid">
      <div><div className="label">المورد</div>{d.supplierName}</div><div><div className="label">التاريخ</div><span className="num">{d.docDate}</span></div>
      <div><div className="label">الدفع</div>{d.paymentType === "CASH" ? "نقدي" : "آجل"}</div>
      <div><div className="label">الإجمالي</div><span className="num">{money(d.total)} {d.currency}</span></div>
      {d.currency !== "IQD" && <div><div className="label">سعر الصرف المثبّت</div><span className="num">{money(d.exchangeRate)}</span></div>}
      {d.status !== "DRAFT" && <div><div className="label">القيمة بالدينار</div><span className="num">{money(d.totalBase)} IQD</span></div>}
      {d.outstanding !== undefined && d.paymentType === "CREDIT" && <div><div className="label">المتبقي للسداد</div><strong className="num">{money(d.outstanding)} {d.currency}</strong></div>}
    </div>
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>#</th><th>المادة</th><th>الكمية</th><th>الكمية الأساسية</th><th>السعر</th><th>الإجمالي</th></tr></thead>
      <tbody>{d.lines.map((l) => <tr key={l.id}><td>{l.lineNo}</td><td>{l.productCode} — {l.productName}{l.profitClass === "USED" ? <span className="badge"> مستعمل</span> : null}</td><td><span className="num">{money(l.qty)} {l.uom}</span></td><td><span className="num">{money(l.qtyBase)}</span></td>
        <td><span className="num">{money(l.unitPrice)}</span></td><td><span className="num">{money(l.lineTotal)}</span></td></tr>)}</tbody></table></div>
    {d.charges.length > 0 && <div className="card" style={{ marginTop: 12 }}><h2>تكاليف إضافية</h2><table><tbody>{d.charges.map((c, i) => <tr key={i}><td>{{ TRANSPORT: "نقل", LOADING: "تحميل", CUSTOMS: "جمارك", OTHER: "أخرى" }[c.kind]} {c.description}</td><td><span className="num">{money(c.amount)} {d.currency}</span></td><td>{c.capitalize ? "ضمن كلفة المخزون" : "مصروف"}</td></tr>)}</tbody></table></div>}
    <MsgBox msg={msg} />
    <p style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
      {d.status === "DRAFT" && can(me, "purchase:approve") && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/purchases/${id}/post`, { method: "POST" }), "تم الترحيل وإصدار الرقم النهائي")}>اعتماد</button>}
      {posted && <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}><button type="button" className="primary" onClick={() => setPayOpen(true)}
        disabled={d.paymentType !== "CREDIT" || Number(d.outstanding ?? 0) <= 0 || !can(me, "voucher:create") || !can(me, "voucher:approve")}>تسجيل دفعة</button>
        {(d.paymentType !== "CREDIT" || Number(d.outstanding ?? 0) <= 0 || !can(me, "voucher:create") || !can(me, "voucher:approve")) && <small>{d.paymentType !== "CREDIT" ? "فاتورة نقدية؛ لا يوجد مستحق" : Number(d.outstanding ?? 0) <= 0 ? "مسدَّدة بالكامل" : "لا تملك صلاحية سندات الصرف"}</small>}</span>}
      <a href={`/print/purchase/${id}`} target="_blank" rel="noreferrer"><button>طباعة / PDF</button></a>
      {d.status === "DRAFT" && can(me, "purchase:edit_draft") && <Link href={`/purchases/new?edit=${id}`}><button>✏️ تعديل</button></Link>}
      {d.status === "DRAFT" && can(me, "purchase:edit_draft") && <button className="danger" disabled={busy} onClick={async () => { if (await run(() => api(`/api/purchases/${id}`, { method: "DELETE" }), "حُذفت المسودة")) router.push("/purchases"); }}>حذف المسودة</button>}
    </p>
    {payOpen && <PayPurchaseDialog purchaseId={id} supplierName={d.supplierName} docNo={d.docNo ?? d.draftRef} currency={d.currency} remaining={d.outstanding ?? "0"} onClose={() => setPayOpen(false)} onDone={(m) => { setPayOpen(false); setMsg({ t: "ok", m }); void reload(); }} />}
    <Attach entityType="purchase_order" entityId={id} label="صور فاتورة المورد والإيصالات" />
    {posted && can(me, "purchase:cancel") && <div className="card" style={{ marginTop: 12 }}><h2>حذف الفاتورة</h2><p>لا يُعدَّل المستند المرحّل؛ يُنشأ قيد عكسي بالسبب أدناه.</p>
      <div className="row"><div><label htmlFor="rs">السبب</label><input id="rs" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <button className="danger" disabled={busy || reason.length < 3} onClick={() => run(() => api(`/api/purchases/${id}/reverse`, { method: "POST", body: { reason } }), "تم عكس المستند")}>حذف</button>
        <button disabled={busy || reason.length < 3} title="يعكس الفاتورة ثم يفتح نسخة جديدة منها للتعديل" onClick={async () => { const r = await run(() => api(`/api/purchases/${id}/reverse`, { method: "POST", body: { reason } }), "تم العكس — عدّل النسخة الجديدة"); if (r !== undefined) router.push(`/purchases/new?copy=${id}`); }}>✏️ تصحيح (عكس + نسخة جديدة)</button></div></div>}
    {posted && can(me, "purchase:create") && <div className="card" style={{ marginTop: 12 }}><h2>مرتجع للمورد</h2>
      <p>يعود المرتجع من نفس طبقة الشراء وبتكلفتها. ما بيع منها يتطلب سبباً استثنائياً وموافقة المالك.</p>
      {d.lines.map((l) => <div className="row" key={l.id}><div>{l.productName} (المشترى {money(l.qtyBase)})</div><div><label>الكمية المرتجعة (وحدة أساسية)</label><input value={ret[l.id] ?? ""} onChange={(e) => setRet({ ...ret, [l.id]: e.target.value })} inputMode="decimal" dir="ltr" /></div></div>)}
      <div className="row"><div><label>سبب المرتجع</label><input id="rr" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <div><label>سبب استثنائي (للكمية المباعة — للمالك)</label><input value={exc} onChange={(e) => setExc(e.target.value)} /></div></div>
      <button disabled={busy} onClick={async () => {
        const lines = d.lines.filter((l) => ret[l.id]).map((l) => ({ purchaseLineId: l.id, qtyBase: ret[l.id], exceptionalReason: exc || null }));
        const r = await run(() => api<{ id: string }>("/api/purchase-returns", { method: "POST", body: { purchaseId: id, docDate: today(), settlement: d.paymentType === "CASH" ? "CASH_REFUND" : "REDUCE_PAYABLE", cashAccountId: d.paymentType === "CASH" ? d.cashAccountId : null, reason, lines } }), "حُفظ المرتجع كمسودة");
        if (r) { const ok2 = await run(() => api(`/api/purchase-returns/${r.id}/post`, { method: "POST" }), "تم ترحيل المرتجع — فُتح مستند الطباعة"); if (ok2 !== undefined) window.open(`/print/doc/purchase-return/${r.id}`, "_blank"); }
      }}>إنشاء وترحيل المرتجع</button>{d.paymentType === "CASH" && <p className="badge">المرتجع النقدي يُردّ إلى نفس صندوق الفاتورة</p>}</div>}
  </>);
}
