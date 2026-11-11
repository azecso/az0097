"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import Decimal from "decimal.js";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, StatusBadge, useAction, useLoad } from "@/components/ui";
import { Attach } from "@/components/attach";
import { Modal } from "@/components/modal";
import { CollectDialog } from "@/components/pay-dialog";

interface Line { id: string; lineNo: number; productCode: string; productName: string; uom: string; qty: string; qtyBase: string; unitPrice: string; lineDiscount: string; lineTotal: string; delivered: string; returned: string; profitClass?: string }
interface Rc { id: string; docNo: string; docDate: string; currency: string; settlementRate: string | null; auto: boolean; amount: string; external: string }
interface Doc { breakdown?: { invoiced: string; deliveredValue: string; deliveredRatio: string; collected: string; external: string; remaining: string; advanceOnUndelivered: string; eligibleProfitBase: string; outside?: { excludedNet: string; excludedCost: string; marginBase: string; recordedOutside: string; cashCollected: string } | null }; id: string; customerId: string; docNo: string | null; draftRef: string; docDate: string; customerName: string; saleType: string; currency: string; exchangeRate: string; gross: string; discount: string; net: string; netBase: string; status: string; deliveryMode: string; cashAccountId: string | null;
  lines: Line[]; collected?: string; external?: string; outstanding?: string; returned?: string; cogsBase?: string | null; profit?: { grossProfitBase: string; adjustedProfitBase: string; collectedRatio: string; linkedProfitBase: string } | null; terms: string | null; receipts?: Rc[] }
type Hist = { chain: { id: string; docNo: string; status: string; net: string; createdAt: string; replaced: boolean }[]; events: { id: string; at: string; user: string; action: string; reason: string | null }[] };

/** A button that is never silently missing: when the action is not available it stays visible, disabled, with the reason beside it. */
function Act({ label, onClick, reason, primary, danger, busy }: { label: string; onClick?: () => void; reason?: string | null; primary?: boolean; danger?: boolean; busy?: boolean }) {
  return (<span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}><button type="button" className={primary ? "primary" : danger ? "danger" : ""} disabled={!!reason || busy} onClick={onClick} title={reason ?? undefined}>{label}</button>{reason && <small style={{ maxWidth: 170 }}>{reason}</small>}</span>);
}

export default function InvoiceView() {
  const { id } = useParams<{ id: string }>(); const router = useRouter(); const me = useMe();
  const { data: d, reload, err } = useLoad<Doc | null>(`/api/sales-invoices/${id}`, null); const { msg, busy, run, setMsg } = useAction(reload);
  const [dlg, setDlg] = useState<"" | "collect" | "deliver" | "return" | "more">(""); const [hist, setHist] = useState<Hist | null>(null);
  const [reason, setReason] = useState(""); const [ret, setRet] = useState<Record<string, string>>({}); const [dq, setDq] = useState<Record<string, string>>({});
  const cst = useLoad<{ unappliedCredit?: string } | null>(d && d.status === "POSTED" ? `/api/customers/${d.customerId}/statement` : null, null).data;
  if (!d) return <p>{err || "جارٍ التحميل…"}</p>;
  const posted = d.status === "POSTED"; const canProfit = can(me, "report:view"); const outstanding = new Decimal(d.outstanding ?? 0);
  const payState = !posted ? null : outstanding.lte(0) ? "مسدَّدة" : new Decimal(d.collected ?? 0).plus(d.external ?? 0).gt(0) ? "مسدَّدة جزئياً" : "غير مسدَّدة";
  const undelivered = d.lines.some((l) => new Decimal(l.qtyBase).gt(l.delivered));
  // reasons shown when an action is not available
  const noCollect = !posted ? "اعتمد الفاتورة أولاً" : !can(me, "voucher:create") || !can(me, "voucher:approve") ? "لا تملك صلاحية سندات القبض" : outstanding.lte(0) ? "الفاتورة مسدَّدة بالكامل" : null;
  const noDeliver = !posted ? "اعتمد الفاتورة أولاً" : d.deliveryMode !== "SEPARATE" ? "التسليم تم مع الفاتورة" : !can(me, "sales:create") ? "لا تملك الصلاحية" : !undelivered ? "سُلِّمت الكميات كاملة" : null;
  const noReturn = !posted ? "اعتمد الفاتورة أولاً" : !can(me, "sales:create") ? "لا تملك الصلاحية" : null;
  const done = (m: string) => { setDlg(""); setMsg({ t: "ok", m }); void reload(); };
  return (<>
    <h1>فاتورة بيع <span className="num">{d.docNo ?? d.draftRef}</span> <StatusBadge s={d.status} /> {payState && <span className="badge">{payState}</span>}</h1>
    <div className="card" role="toolbar" aria-label="إجراءات الفاتورة" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
      {d.status === "DRAFT" && <Act primary label="اعتماد" busy={busy} reason={can(me, "sales:approve") ? null : "لا تملك صلاحية الاعتماد"} onClick={() => void run(() => api(`/api/sales-invoices/${id}/post`, { method: "POST" }), "تم الاعتماد وإصدار الرقم النهائي")} />}
      {posted && <Act primary label="تسجيل تسديد" reason={noCollect} onClick={() => setDlg("collect")} />}
      {posted && <Act label="تسجيل تسليم" reason={noDeliver} onClick={() => setDlg("deliver")} />}
      {posted && <Act label="مرتجع" reason={noReturn} onClick={() => setDlg("return")} />}
      <a href={`/print/sales-invoice/${id}`} target="_blank" rel="noreferrer"><button type="button">طباعة / PDF</button></a>
      {d.status === "DRAFT" && can(me, "sales:edit_draft") && <Link href={`/sales/new?edit=${id}`}><button type="button">تعديل</button></Link>}
      <button type="button" onClick={() => setDlg("more")} aria-haspopup="dialog">إجراءات إضافية</button>
    </div>
    <MsgBox msg={msg} />
    <div className="card grid" style={{ marginTop: 12 }}>
      <div><div className="label">العميل</div>{d.customerName}</div><div><div className="label">التاريخ</div><span className="num">{d.docDate}</span></div>
      <div><div className="label">النوع</div>{d.saleType === "CASH" ? "نقدي" : "آجل"} — {d.deliveryMode === "WITH_INVOICE" ? "تسليم مع الفاتورة" : "تسليم منفصل"}</div>
      <div><div className="label">الإجمالي</div><span className="num">{money(d.gross)} {d.currency}</span></div>
      {Number(d.discount) > 0 && <div><div className="label">الخصم</div><span className="num">{money(d.discount)}</span></div>}
      <div><div className="label">الصافي</div><strong className="num">{money(d.net)} {d.currency}</strong></div>
      {d.currency !== "IQD" && <div><div className="label">سعر الصرف المثبّت</div><span className="num">{money(d.exchangeRate)}</span></div>}
      {d.outstanding !== undefined && <><div><div className="label">إجمالي المقبوض على هذه الفاتورة</div><span className="num">{money(d.collected)}</span></div>{Number(d.external) > 0 && <div><div className="label">ربح موزَّع خارج النظام (غير نقدي)</div><span className="num">{money(d.external)}</span></div>}<div><div className="label">المتبقي للقبض</div><strong className="num">{money(d.outstanding)} {d.currency}</strong></div></>}
      {canProfit && d.profit && <><div><div className="label">الربح (على المسلَّم)</div><span className="num">{money(d.profit.grossProfitBase)} IQD</span></div>
        <div><div className="label">الربح المؤهَّل للتوزيع</div><span className="num">{money(d.profit.linkedProfitBase)} IQD</span><small>يتحقق عند التسديد والتسليم الكاملين</small></div></>}
    </div>
    {posted && d.breakdown && <div className="card" style={{ marginTop: 12 }} aria-label="تفصيل الفاتورة"><h2>تفصيل الفاتورة</h2><div className="grid">
      <div className="card stat"><div className="label">المفوتر</div><div className="value"><span className="num">{money(d.breakdown.invoiced)}</span></div><small>{d.currency}</small></div>
      <div className="card stat"><div className="label">المسلَّم (قيمة)</div><div className="value"><span className="num">{money(d.breakdown.deliveredValue)}</span></div><small>{new Decimal(d.breakdown.deliveredRatio).mul(100).toDecimalPlaces(0).toString()}% من الكميات</small></div>
      <div className="card stat"><div className="label">المقبوض</div><div className="value"><span className="num">{money(d.breakdown.collected)}</span></div>{Number(d.breakdown.external) > 0 && <small>+ ربح خارجي {money(d.breakdown.external)}</small>}</div>
      <div className="card stat"><div className="label">المتبقي</div><div className="value"><span className="num">{money(d.breakdown.remaining)}</span></div></div>
      {Number(d.breakdown.advanceOnUndelivered) > 0 && <div className="card stat"><div className="label">دفعة مقدّمة على بضاعة لم تُسلَّم</div><div className="value"><span className="num">{money(d.breakdown.advanceOnUndelivered)}</span></div><small>ليست ربحاً</small></div>}
      {canProfit && <div className="card stat"><div className="label">الربح المؤهَّل للتوزيع</div><div className="value"><span className="num">{money(d.breakdown.eligibleProfitBase)}</span></div><small>IQD</small></div>}</div></div>}
    {posted && (d.receipts?.length ?? 0) > 0 && <div className="card cards-as-list" style={{ marginTop: 12 }}><h2>سجل التسديد</h2><table><thead><tr><th>السند</th><th>التاريخ</th><th>المسدَّد من الفاتورة</th><th>تسوية غير نقدية</th><th>سعر التحويل</th><th></th></tr></thead>
      <tbody>{d.receipts!.map((r) => <tr key={r.id}><td><span className="num">{r.docNo}</span>{r.auto ? " (تلقائي)" : ""}</td><td><span className="num">{r.docDate}</span></td><td><span className="num">{money(r.amount)} {d.currency}</span></td><td>{Number(r.external) > 0 ? <span className="num">{money(r.external)}</span> : "—"}</td><td>{r.settlementRate ? <span className="num">{money(r.settlementRate)}</span> : "—"}</td><td><a href={`/print/receipt/${r.id}`} target="_blank" rel="noreferrer">طباعة</a></td></tr>)}</tbody></table></div>}
    {posted && d.currency === "IQD" && cst?.unappliedCredit && new Decimal(cst.unappliedCredit).gt(0) && outstanding.gt(0) && can(me, "voucher:create") && can(me, "voucher:approve") && (() => {
      const use = Decimal.min(new Decimal(cst.unappliedCredit), outstanding).toString();
      return <div className="card" style={{ marginTop: 12, borderColor: "var(--accent)" }}><strong>لهذا العميل رصيد دائن غير مخصَّص: {money(cst.unappliedCredit)} IQD</strong>
        <p>يمكنك تسوية <span className="num">{money(use)}</span> منه على هذه الفاتورة فيصير المتبقي <span className="num">{money(outstanding.minus(use).toString())}</span>.</p>
        <button className="primary" disabled={busy} onClick={() => run(async () => { const r = await api<{ id: string }>("/api/customer-receipts", { method: "POST", body: { customerId: d.customerId, docDate: today(), kind: "CREDIT_APPLICATION", cashAccountId: null, currency: "IQD", amount: use, allocations: [{ invoiceId: id, amount: use }] } }); await api(`/api/customer-receipts/${r.id}/post`, { method: "POST" }); }, "تمت تسوية الرصيد الدائن على الفاتورة")}>تسوية الرصيد الدائن على هذه الفاتورة</button></div>; })()}
    <div className="card cards-as-list" style={{ marginTop: 12 }}><table><thead><tr><th>#</th><th>المادة</th><th>الكمية</th><th>السعر</th><th>الخصم</th><th>الإجمالي</th>{posted && <><th>المسلّم</th><th>المرتجع</th></>}</tr></thead>
      <tbody>{d.lines.map((l) => <tr key={l.id}><td>{l.lineNo}</td><td>{l.productCode} — {l.productName}{l.profitClass === "USED" ? <span className="badge"> الربح خارج التوزيع</span> : null}</td><td><span className="num">{money(l.qty)} {l.uom}</span></td><td><span className="num">{money(l.unitPrice)}</span></td><td><span className="num">{money(l.lineDiscount)}</span></td><td><span className="num">{money(l.lineTotal)}</span></td>
        {posted && <><td><span className="num">{money(l.delivered)}</span> / <span className="num">{money(l.qtyBase)}</span></td><td><span className="num">{money(l.returned)}</span></td></>}</tr>)}</tbody></table></div>
    <Attach entityType="sales_invoice" entityId={id} label="مرفقات الفاتورة (صور/إيصالات)" />

    {dlg === "collect" && <CollectDialog invoiceId={id} customerName={d.customerName} docNo={d.docNo ?? d.draftRef} currency={d.currency} remaining={d.outstanding ?? "0"} isOwner={me.user.isOwner} outside={d.breakdown?.outside ?? null} onClose={() => setDlg("")} onDone={done} />}

    {dlg === "deliver" && <Modal title="تسجيل تسليم" onClose={() => setDlg("")}>
      {d.lines.map((l) => <div className="row" key={l.id}><div>{l.productName} (المتبقي <span className="num">{money(new Decimal(l.qtyBase).minus(l.delivered).toString())}</span>)</div><div><label>الكمية</label><input value={dq[l.id] ?? ""} onChange={(e) => setDq({ ...dq, [l.id]: e.target.value })} dir="ltr" inputMode="decimal" /></div></div>)}
      <button type="button" className="primary" disabled={busy || !Object.values(dq).some(Boolean)} onClick={async () => { const lines = d.lines.filter((l) => dq[l.id]).map((l) => ({ salesLineId: l.id, qtyBase: dq[l.id] })); const r = await run(() => api<{ id: string }>("/api/delivery-notes", { method: "POST", body: { invoiceId: id, docDate: today(), lines } }), "حُفظ السند");
        if (r) { const ok = await run(() => api(`/api/delivery-notes/${r.id}/post`, { method: "POST" }), "تم التسليم وتسجيل التكلفة"); if (ok !== undefined) { setDq({}); setDlg(""); } } }}>تسجيل التسليم</button></Modal>}

    {dlg === "return" && <Modal title="مرتجع من العميل" onClose={() => setDlg("")}>
      <p><small>تعود البضاعة إلى نفس الطبقات بتكلفتها الأصلية؛ يُخصم أولاً من المتبقي على العميل، والفائض رصيد دائن للعميل.</small></p>
      {d.lines.map((l) => <div className="row" key={l.id}><div>{l.productName}</div><div><label>الكمية المرتجعة</label><input value={ret[l.id] ?? ""} onChange={(e) => setRet({ ...ret, [l.id]: e.target.value })} dir="ltr" inputMode="decimal" /></div></div>)}
      <div><label htmlFor="rt-r">السبب</label><input id="rt-r" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      <button type="button" className="primary" disabled={busy || reason.length < 3 || !Object.values(ret).some(Boolean)} onClick={async () => { const lines = d.lines.filter((l) => ret[l.id]).map((l) => ({ salesLineId: l.id, qtyBase: ret[l.id] }));
        const r = await run(() => api<{ id: string }>("/api/sales-returns", { method: "POST", body: { invoiceId: id, docDate: today(), reason, settlement: "REDUCE_RECEIVABLE", lines } }), "حُفظ المرتجع");
        if (r) { const ok = await run(() => api(`/api/sales-returns/${r.id}/post`, { method: "POST" }), "تم اعتماد المرتجع"); if (ok !== undefined) { setRet({}); setReason(""); setDlg(""); } } }}>اعتماد المرتجع</button></Modal>}

    {dlg === "more" && <Modal title="إجراءات إضافية" onClose={() => setDlg("")}>
      {d.status === "DRAFT" && can(me, "sales:edit_draft") && <button type="button" className="danger" disabled={busy} onClick={async () => { if (await run(() => api(`/api/sales-invoices/${id}`, { method: "DELETE" }), "حُذفت المسودة")) router.push("/sales"); }}>حذف المسودة</button>}
      {posted && can(me, "sales:cancel") && <>
        <Link href={`/sales/new?edit=${id}`}><button type="button">تصحيح الفاتورة (يبقى رقمها وسندات قبضها)</button></Link>
        <button type="button" className="danger" disabled={busy} onClick={async () => { const why = window.prompt("سبب إلغاء الفاتورة (يُحفظ في سجل التدقيق)؟"); if (!why || why.trim().length < 3) return;
          const call = (cascade: boolean) => api(`/api/sales-invoices/${id}/reverse`, { method: "POST", body: { reason: why.trim(), cascade } });
          const r = await run(async () => { try { return await call(false); } catch (e) { if ((e as { code?: string }).code === "HAS_RECEIPTS" && window.confirm("عليها سندات قبض. هل تُلغى سندات القبض معها (يعود المبلغ من الصندوق)؟")) return await call(true); throw e; } }, "أُلغيت الفاتورة"); if (r !== undefined) router.push("/sales"); }}>إلغاء الفاتورة (قيد عكسي)</button>
        <small>الإلغاء لا يمحو أثراً: يُسجَّل قيد عكسي ويبقى كل شيء في سجل التدقيق. التصحيح يحافظ على رقم الفاتورة. لا يصح الإلغاء مع وجود مرتجع.</small></>}
      {posted && can(me, "audit:view") && <button type="button" onClick={() => api<Hist>(`/api/document-history/sales-invoices/${id}`).then(setHist)}>سجل إصدارات الفاتورة</button>}
      {hist && <div className="card cards-as-list"><table><thead><tr><th>الإصدار</th><th>الحالة</th><th>الصافي</th><th>التاريخ</th></tr></thead><tbody>{hist.chain.map((c) => <tr key={c.id}><td><span className="num">{c.docNo}</span>{c.replaced ? " (استُبدل)" : " (الحالي)"}</td><td>{c.status}</td><td><span className="num">{money(c.net)}</span></td><td><span className="num">{new Date(c.createdAt).toLocaleString("ar-IQ")}</span></td></tr>)}</tbody></table>
        <table><thead><tr><th>الإجراء</th><th>المستخدم</th><th>الوقت</th><th>السبب</th></tr></thead><tbody>{hist.events.map((e) => <tr key={e.id}><td>{e.action}</td><td>{e.user}</td><td><span className="num">{new Date(e.at).toLocaleString("ar-IQ")}</span></td><td>{e.reason ?? ""}</td></tr>)}</tbody></table></div>}
    </Modal>}
  </>);
}
