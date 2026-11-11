"use client";
import { useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { api, money, today } from "@/lib/client";
import { Modal } from "@/components/modal";
import { FxRateField } from "@/components/fx-rate-field";

interface Cash { id: string; name: string; currency: string; kind: string }
const typedRate = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value?.trim() || null;
const dec = (v: string) => { try { return new Decimal(v || 0); } catch { return new Decimal(0); } };

/**
 * «تسجيل تسديد» from the invoice: customer, invoice and remaining are pre-filled; one press creates AND posts the linked receipt (atomic, idempotent: the same requestId is reused
 * for retries, so a double click or a retry after a network error can never create two receipts). Money received in another currency settles through an explicit, visible rate.
 */
export interface OutsideInfo { excludedNet: string; excludedCost: string; marginBase: string; recordedOutside: string; cashCollected: string }
export function CollectDialog({ invoiceId, customerName, docNo, currency, remaining, isOwner, outside: info, onClose, onDone }: { invoiceId: string; customerName: string; docNo: string; currency: string; remaining: string; isOwner: boolean; outside?: OutsideInfo | null; onClose: () => void; onDone: (m: string) => void }) {
  const [cash, setCash] = useState<Cash[]>([]); const [acct, setAcct] = useState(""); const [amount, setAmount] = useState(remaining); const [date, setDate] = useState(today());
  const [srate, setSrate] = useState(""); const [more, setMore] = useState(false); const [notes, setNotes] = useState(""); const [ext, setExt] = useState(false); const [extNote, setExtNote] = useState("");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [rid] = useState(() => `collect-${crypto.randomUUID()}`);        // stable across retries of THIS dialog
  // goods whose profit is outside the distribution: the box gets the COST back, the margin above cost is received outside the box. Suggestions only — the user confirms or edits every figure.
  const marginLeft = info ? Decimal.max(0, dec(info.excludedNet).minus(info.excludedCost).minus(info.recordedOutside)) : new Decimal(0);
  const [outsideAmt, setOutsideAmt] = useState("0");
  const suggest = (paid: Decimal) => { const out = Decimal.max(0, Decimal.min(marginLeft, paid.minus(Decimal.max(0, dec(remaining).minus(marginLeft))))); return { out, cash: paid.minus(out) }; };      // cash first for cost (and any regular part), margin last
  const applySuggestion = (paidTxt: string) => { const sg = suggest(dec(paidTxt)); setOutsideAmt(sg.out.toString()); setAmount(sg.cash.toString()); };
  useEffect(() => { if (info) applySuggestion(remaining); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  useEffect(() => { void api<Cash[]>("/api/cash-accounts").then((c) => { setCash(c); const same = c.find((x) => x.currency === currency && x.kind !== "PARTNER_CUSTODY") ?? c[0]; if (same) setAcct(same.id); }); }, [currency]);
  const ca = cash.find((c) => c.id === acct); const cross = !!ca && ca.currency !== currency;
  useEffect(() => { if (cross && !srate) void api<{ rate: string | null }>(`/api/fx-rates/check?currency=USD&date=${date}`).then((r) => { if (r.rate) setSrate(r.rate); }); }, [cross, date, srate]);
  const settled = useMemo(() => {
    if (!ca) return null; if (!cross) return dec(amount);
    const r = dec(srate); if (r.lte(0)) return null;
    return ca.currency === "USD" ? dec(amount).mul(r).toDecimalPlaces(0) : dec(amount).div(r).toDecimalPlaces(2);
  }, [ca, cross, amount, srate]);
  const rem = dec(remaining); const extAmount = ext ? Decimal.max(0, rem.minus(dec(amount))) : new Decimal(0);
  const outsideNum = dec(outsideAmt); const totalPaid = (settled ?? new Decimal(0)).plus(outsideNum);
  const over = settled && settled.plus(outsideNum).gt(rem.minus(extAmount));
  async function submit() {
    setErr(""); setBusy(true);
    try {
      const r = await api<{ docNo: string; outstanding: string; status: string; surplusToCredit: string }>(`/api/sales-invoices/${invoiceId}/collect`, { method: "POST", body: { requestId: rid, docDate: date, cashAccountId: acct, currency: ca!.currency, settlementRate: cross ? srate : null, exchangeRate: ca!.currency === "USD" ? typedRate("pd-r") : null, amount, externalAmount: ext ? extAmount.toString() : "0", externalNote: ext ? extNote || null : null, outsideAmount: info ? outsideNum.toString() : "0", notes: notes || null } });
      onDone(`تم تسجيل التسديد — السند ${r.docNo} — المتبقي ${money(r.outstanding)} ${currency}${Number(r.surplusToCredit) > 0 ? ` — ${money(r.surplusToCredit)} أُضيفت كرصيد دائن للعميل` : ""}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (<Modal title="تسجيل تسديد" onClose={onClose}>
    <div className="card" style={{ background: "var(--bg-soft, #f6f7f9)" }}><div><b>العميل:</b> {customerName}</div><div><b>الفاتورة:</b> <span className="num">{docNo}</span> — المتبقي <b className="num">{money(remaining)} {currency}</b></div></div>
    <div><label htmlFor="pd-d">التاريخ</label><input id="pd-d" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
    <div><label htmlFor="pd-c">الصندوق / الحساب</label><select id="pd-c" value={acct} onChange={(e) => { setAcct(e.target.value); setSrate(""); }}>{cash.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}</select></div>
    {info && <div className="msg" role="group" aria-label="بضاعة الربح خارج التوزيع"><b>فاتورة فيها بضاعة «الربح خارج التوزيع»</b>
      <div>إجمالي الفاتورة / المتبقي: <b className="num">{money(remaining)} {currency}</b> — كلفة الكميات المباعة: <b className="num">{money(info.excludedCost)} {currency}</b></div>
      <div><label htmlFor="pd-paid">إجمالي ما سدده العميل فعلياً الآن ({currency})</label><input id="pd-paid" inputMode="decimal" dir="ltr" value={totalPaid.toString()} onChange={(e) => applySuggestion(e.target.value)} /></div>
      <div><label htmlFor="pd-out">المستلم خارج الصندوق ({currency}) — فرق الربح</label><input id="pd-out" inputMode="decimal" dir="ltr" value={outsideAmt} onChange={(e) => setOutsideAmt(e.target.value)} /></div>
      <small>الداخل للصندوق (أدناه) = ما يدخله فعلاً. النظام يقترح ويعرض للتأكيد؛ لا يُسجَّل نقد لم يدخل. الباقي من الفاتورة يبقى ذمة. هامش متاح للاستلام خارج الصندوق: <span className="num">{money(marginLeft.toString())}</span></small></div>}
    <div><label htmlFor="pd-a">{info ? "الداخل للصندوق" : "المبلغ المقبوض"}{ca ? ` (${ca.currency})` : ""}</label>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><input id="pd-a" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" dir="ltr" />{!cross && !info && <button type="button" onClick={() => setAmount(remaining)}>المتبقي كاملاً</button>}</div></div>
    {cross && <div className="msg" role="status"><div><label htmlFor="pd-sr">سعر التحويل (دينار لكل 1$) — صريح ويُحفظ على السند</label><input id="pd-sr" value={srate} onChange={(e) => setSrate(e.target.value)} inputMode="decimal" dir="ltr" /></div>
      {settled && <div>{money(amount || "0")} {ca!.currency} = <b className="num">{money(settled.toString())} {currency}</b> تُسدَّد من الفاتورة</div>}</div>}
    {ca?.currency === "USD" && <FxRateField id="pd-r" name="pd-r" label="سعر صرف يوم القبض (لقيد الصندوق — فارغ = سعر اليوم)" />}
    {over && <div className="msg err" role="alert">المبلغ يتجاوز المتبقي؛ الزائد يُسجَّل رصيداً دائناً للعميل.</div>}
    <button type="button" onClick={() => setMore(!more)} aria-expanded={more}>{more ? "إخفاء" : "تفاصيل إضافية"}</button>
    {more && <><div><label htmlFor="pd-n">ملاحظات</label><input id="pd-n" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      {isOwner && currency === "IQD" && ca?.currency === "IQD" && <div><label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><input type="checkbox" style={{ width: 22, minHeight: 22 }} checked={ext} onChange={(e) => setExt(e.target.checked)} />بدون أرباح (الباقي ربح موزَّع خارج النظام)</label>
        {ext && <><input aria-label="ملاحظة" placeholder="ملاحظة (اختيارية)" value={extNote} onChange={(e) => setExtNote(e.target.value)} /><small>الباقي {money(extAmount.toString())} {currency} يُسجَّل تسوية غير نقدية (نصفها لكل شريك) ولا يدخل الصندوق.</small></>}</div>}</>}
    {err && <div className="msg err" role="alert">{err}</div>}
    <div style={{ display: "flex", gap: 8 }}><button type="button" className="primary" disabled={busy || !acct || (!dec(amount).gt(0) && !(info && outsideNum.gt(0))) || (cross && !settled)} onClick={() => void submit()}>{busy ? "جارٍ التسجيل…" : "تسجيل التسديد"}</button><button type="button" onClick={onClose}>إلغاء</button></div>
  </Modal>);
}

/** «تسجيل دفعة» from the purchase invoice: supplier, invoice and remaining pre-filled; one atomic idempotent action. */
export function PayPurchaseDialog({ purchaseId, supplierName, docNo, currency, remaining, onClose, onDone }: { purchaseId: string; supplierName: string; docNo: string; currency: string; remaining: string; onClose: () => void; onDone: (m: string) => void }) {
  const [cash, setCash] = useState<Cash[]>([]); const [acct, setAcct] = useState(""); const [amount, setAmount] = useState(remaining); const [date, setDate] = useState(today()); const [notes, setNotes] = useState(""); const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [rid] = useState(() => `pay-${crypto.randomUUID()}`);
  useEffect(() => { void api<Cash[]>("/api/cash-accounts").then((c) => { const ok = c.filter((x) => x.currency === currency && x.kind !== "PARTNER_CUSTODY"); setCash(ok); if (ok[0]) setAcct(ok[0].id); }); }, [currency]);
  async function submit() {
    setErr(""); setBusy(true);
    try { const r = await api<{ docNo: string; outstanding: string }>(`/api/purchases/${purchaseId}/pay`, { method: "POST", body: { requestId: rid, docDate: date, cashAccountId: acct, currency, exchangeRate: currency === "USD" ? typedRate("pp-r") : null, amount, notes: notes || null } }); onDone(`تم تسجيل الدفعة — السند ${r.docNo} — المتبقي ${money(r.outstanding)} ${currency}`); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (<Modal title="تسجيل دفعة للمورد" onClose={onClose}>
    <div className="card" style={{ background: "var(--bg-soft, #f6f7f9)" }}><div><b>المورد:</b> {supplierName}</div><div><b>الفاتورة:</b> <span className="num">{docNo}</span> — المتبقي <b className="num">{money(remaining)} {currency}</b></div></div>
    <div><label htmlFor="pp-d">التاريخ</label><input id="pp-d" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
    <div><label htmlFor="pp-c">الصندوق ({currency})</label><select id="pp-c" value={acct} onChange={(e) => setAcct(e.target.value)}>{cash.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
    <div><label htmlFor="pp-a">المبلغ ({currency})</label><div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}><input id="pp-a" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" dir="ltr" /><button type="button" onClick={() => setAmount(remaining)}>المتبقي كاملاً</button></div></div>
    {currency === "USD" && <FxRateField id="pp-r" name="pp-r" label="سعر صرف يوم الدفع (فارغ = سعر اليوم)" />}
    <button type="button" onClick={() => setMore(!more)} aria-expanded={more}>{more ? "إخفاء" : "تفاصيل إضافية"}</button>
    {more && <div><label htmlFor="pp-n">ملاحظات</label><input id="pp-n" value={notes} onChange={(e) => setNotes(e.target.value)} /></div>}
    {err && <div className="msg err" role="alert">{err}</div>}
    <div style={{ display: "flex", gap: 8 }}><button type="button" className="primary" disabled={busy || !acct || !dec(amount).gt(0)} onClick={() => void submit()}>{busy ? "جارٍ التسجيل…" : "تسجيل الدفعة"}</button><button type="button" onClick={onClose}>إلغاء</button></div>
  </Modal>);
}
