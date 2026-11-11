"use client";
import { useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { api, money, today } from "@/lib/client";
import { Modal } from "@/components/modal";

interface Cash { id: string; name: string; currency: string; kind: string }
interface Cust { id: string; name: string; kind: string }
interface Inv { id: string; docNo: string | null; docDate: string; customerId: string; customerName: string; currency: string; net: string; status: string; outstanding: string | null }
const dec = (v: string) => { try { return new Decimal(v || 0); } catch { return new Decimal(0); } };
const isInt = (v: string) => /^\d+$/.test(v.trim());

/**
 * «استلام بالدولار» against a dinar invoice. The user states the dollars received and the dinar balance that remains (or none); no exchange rate is asked for and none is used to decide the
 * balance. Settled dinars = balance before − balance after; the implied rate is derived and recorded for accounting/audit only.
 * Zeroing the invoice needs an explicit confirmation dialog that is never remembered; the SERVER re-verifies the confirmation against the current figures.
 */
export function UsdReceiptDialog({ customerId: cid0, invoiceId: iid0, edit, onClose, onDone }: { customerId?: string; invoiceId?: string; edit?: { receiptId: string }; onClose: () => void; onDone: (m: string) => void }) {
  const [rid, setRid] = useState(() => `usd-${crypto.randomUUID()}`);
  const [cash, setCash] = useState<Cash[]>([]); const [custs, setCusts] = useState<Cust[]>([]); const [invs, setInvs] = useState<Inv[]>([]);
  const [form, setForm] = useState<any>(null);
  const [customerId, setCustomerId] = useState(cid0 ?? ""); const [invoiceId, setInvoiceId] = useState(iid0 ?? "");
  const [acct, setAcct] = useState(""); const [usd, setUsd] = useState(""); const [date, setDate] = useState(today()); const [keep, setKeep] = useState(false); const [rem, setRem] = useState(""); const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [confirm, setConfirm] = useState(false); const [reload, setReload] = useState(0);
  useEffect(() => { void api<Cash[]>("/api/cash-accounts").then((c) => { const u = c.filter((x) => x.currency === "USD"); setCash(u); setAcct((a) => a || u.find((x) => x.kind !== "PARTNER_CUSTODY")?.id || u[0]?.id || ""); }); }, []);
  useEffect(() => { if (!cid0) void api<Cust[]>("/api/contacts?kind=CUSTOMER").then(setCusts); }, [cid0]);
  useEffect(() => { void api<Inv[]>("/api/sales-invoices?status=POSTED").then(setInvs); }, [reload]);
  useEffect(() => { if (!edit) return; void api<any>(`/api/customer-receipts/${edit.receiptId}/edit`).then((f) => {
    setForm(f); setCustomerId(f.customerId); setInvoiceId(f.allocations[0]?.invoiceId ?? ""); setAcct(f.cashAccountId); setUsd(String(Number(f.amount))); setDate(f.docDate); setNotes(f.notes ?? "");
    const ra = Number(f.remainingAfter ?? 0); setKeep(ra > 0); setRem(ra > 0 ? String(ra) : ""); }); }, [edit]);
  // invoices of the chosen customer that still have a balance (the invoice being edited keeps the balance it had WITHOUT this receipt)
  const editBal = form?.allocations?.[0];
  const list = useMemo(() => invs.filter((i) => i.customerId === customerId && i.currency === "IQD" && i.status === "POSTED").map((i) => ({ ...i, out: editBal && editBal.invoiceId === i.id ? editBal.outstandingWithout : i.outstanding ?? "0" })).filter((i) => dec(i.out).gt(0)), [invs, customerId, editBal]);
  const inv = list.find((i) => i.id === invoiceId); const out = inv ? dec(inv.out) : new Decimal(0);
  const usdN = dec(usd); const remN = keep ? dec(rem) : new Decimal(0);
  const paid = out.minus(remN);
  const problems: string[] = [];
  if (!customerId) problems.push("اختر العميل"); else if (!inv) problems.push("اختر الفاتورة");
  if (!acct) problems.push("اختر صندوق الدولار"); if (!usdN.gt(0)) problems.push("أدخل مبلغ الدولار المستلم");
  if (keep) { if (!isInt(rem) || !remN.gt(0)) problems.push("أدخل المتبقي بذمة العميل بالدينار (رقم موجب)"); else if (inv && remN.gte(out)) problems.push("المتبقي يجب أن يكون أقل من المتبقي الحالي؛ للتسديد الكامل ألغِ تفعيل الخيار"); }
  const ok = problems.length === 0;
  const implied = ok && usdN.gt(0) ? paid.div(usdN) : null;
  const payload = () => ({ invoiceId, customerId, docDate: date, cashAccountId: acct, usdAmount: usdN.toString(), keepRemainder: keep, remainingIqd: keep ? remN.toString() : null, expectedOutstanding: out.toString(), notes: notes.trim() || null,
    fullSettlementConfirmation: keep ? null : { invoiceId, customerId, cashAccountId: acct, usdAmount: usdN.toString(), outstandingBefore: out.toString() } });
  async function submit() {
    setErr(""); setBusy(true);
    try {
      const body = payload();
      const r = edit ? await api<{ docNo: string }>(`/api/customer-receipts/${edit.receiptId}/amend-usd`, { method: "POST", body: { ...body, version: form.version } })
        : await api<{ docNo: string; usd: string; settledIqd: string; outstanding: string }>("/api/customer-receipts/usd", { method: "POST", body: { ...body, requestId: rid } });
      const x = r as { docNo: string; settledIqd?: string; outstanding?: string };
      onDone(`تم القبض — السند ${x.docNo}${x.settledIqd ? ` — سُدِّد ${money(x.settledIqd)} د.ع` : ""}${x.outstanding !== undefined ? ` — المتبقي ${money(x.outstanding)} د.ع` : ""}`);
    } catch (e) {
      const c = (e as { code?: string }).code; setErr((e as Error).message); setConfirm(false);
      if (c === "STALE_BALANCE" || c === "FULL_SETTLEMENT_CONFIRMATION_REQUIRED") { setReload((n) => n + 1); setRid(`usd-${crypto.randomUUID()}`); }       // new figures are shown and a NEW confirmation is required
    } finally { setBusy(false); }
  }
  function press() { setErr(""); if (!ok) return; if (keep) void submit(); else setConfirm(true); }       // zeroing the invoice never happens without the extra dialog
  return (<Modal title={edit ? `تعديل سند القبض بالدولار ${form?.docNo ?? ""}` : "استلام بالدولار مقابل فاتورة دينار"} onClose={() => { if (confirm) setConfirm(false); else onClose(); }}>
    <div className="msg">لا يُستخدم سعر صرف هنا: أنت تحدد الدولار المقبوض والمتبقي بالدينار، ويحتسب النظام معادل التسديد.</div>
    <div><label htmlFor="ud-c">العميل</label>{cid0 || edit ? <div><b>{custs.find((c) => c.id === customerId)?.name ?? invs.find((i) => i.customerId === customerId)?.customerName ?? ""}</b></div>
      : <select id="ud-c" value={customerId} onChange={(e) => { setCustomerId(e.target.value); setInvoiceId(""); }}><option value="">اختر العميل…</option>{custs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</div>
    <div><label htmlFor="ud-i">الفاتورة (غير المسددة فقط)</label>{iid0 || edit ? <div>{inv ? <><b className="num">{inv.docNo}</b> — {inv.docDate}</> : "…"}</div>
      : <select id="ud-i" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} disabled={!customerId}><option value="">{customerId ? (list.length ? "اختر الفاتورة…" : "لا فواتير غير مسددة بالدينار") : "اختر العميل أولاً"}</option>
        {list.map((i) => <option key={i.id} value={i.id}>{i.docNo} — {i.docDate} — المتبقي {money(i.out)} د.ع</option>)}</select>}</div>
    {inv && <div className="card" style={{ background: "var(--bg-soft, #f6f7f9)" }}>المتبقي الحالي على الفاتورة <span className="num">{inv.docNo}</span>: <b className="num">{money(out.toString())} د.ع</b></div>}
    <div><label htmlFor="ud-d">التاريخ</label><input id="ud-d" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
    <div><label htmlFor="ud-a">صندوق الدولار</label><select id="ud-a" value={acct} onChange={(e) => setAcct(e.target.value)}>{cash.map((c) => <option key={c.id} value={c.id}>{c.name} (USD)</option>)}</select>{cash.length === 0 && <small>لا يوجد صندوق دولار</small>}</div>
    <div><label htmlFor="ud-u">مبلغ الدولار المستلم (USD)</label><input id="ud-u" inputMode="decimal" dir="ltr" value={usd} onChange={(e) => setUsd(e.target.value)} /></div>
    <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><input type="checkbox" style={{ width: 22, minHeight: 22 }} checked={keep} onChange={(e) => setKeep(e.target.checked)} />يبقى مبلغ بذمة العميل؟</label>
    {keep && <div><label htmlFor="ud-r">المتبقي بذمة العميل بالدينار (إلزامي)</label><input id="ud-r" inputMode="numeric" dir="ltr" value={rem} onChange={(e) => setRem(e.target.value)} required /></div>}
    {keep && ok && inv && <div className="msg" role="status" aria-label="ملخص التسديد الجزئي"><b>ملخص التسديد الجزئي (قبل الحفظ)</b>
      <div>المتبقي قبل القبض: <b className="num">{money(out.toString())} د.ع</b></div><div>الدولار المستلم: <b className="num">{money(usdN.toString())} USD</b></div>
      <div>معادل التسديد المحتسب: <b className="num">{money(paid.toString())} د.ع</b> <small>(ليس نقد دينار؛ سعر التحويل المستنتج {implied ? money(implied.toDecimalPlaces(4).toString()) : "—"} للحسابات والتدقيق فقط)</small></div>
      <div>المتبقي الجديد بذمة العميل: <b className="num">{money(remN.toString())} د.ع</b></div></div>}
    <div><label htmlFor="ud-n">ملاحظات</label><input id="ud-n" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
    {!ok && usd !== "" && <small role="status">{problems[0]}</small>}
    {err && <div className="msg err" role="alert">{err}</div>}
    <div style={{ display: "flex", gap: 8 }}><button type="button" className="primary" disabled={busy || !ok} onClick={press}>{busy ? "جارٍ التسجيل…" : "تأكيد القبض"}</button><button type="button" onClick={onClose}>إلغاء</button></div>
    {confirm && inv && <Modal title="تأكيد تصفير المتبقي" onClose={() => setConfirm(false)}>
      <div className="msg err" role="alertdialog" aria-label="تأكيد تصفير الفاتورة"><b>لم تحدد مبلغاً متبقياً على العميل. عند التأكيد ستُسجَّل الفاتورة مسددة بالكامل، وسيصبح المتبقي صفراً مقابل مبلغ الدولار الذي أدخلته. هل تريد المتابعة؟</b></div>
      <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", margin: 0 }}>
        <dt>الفاتورة</dt><dd className="num">{inv.docNo}</dd><dt>العميل</dt><dd>{inv.customerName}</dd>
        <dt>المتبقي قبل القبض</dt><dd className="num">{money(out.toString())} د.ع</dd><dt>مبلغ الدولار المستلم</dt><dd className="num">{money(usdN.toString())} USD</dd>
        <dt>المبلغ الذي سيُسدد بالدينار</dt><dd className="num">{money(out.toString())} د.ع</dd><dt>المتبقي بعد العملية</dt><dd className="num"><b>0 د.ع</b></dd></dl>
      <div style={{ display: "flex", gap: 8 }}><button type="button" autoFocus disabled={busy} onClick={() => setConfirm(false)}>رجوع وتعديل المتبقي</button>
        <button type="button" className="danger" disabled={busy} onClick={() => void submit()}>تأكيد القبض وتصفير المتبقي</button></div></Modal>}
  </Modal>);
}
