"use client";
import { useState } from "react";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, StatusBadge, useAction, useLoad } from "@/components/ui";

interface Ov { partners: { id: string; name: string; kind: string; dueProfit: string; payableToPartner: string; advancesOutstanding: string; capital: string; ownerDrawings: string; netDue: string }[]; liquidity: { cash: string; committed: string; available: string }; lossCarriedForward: string }
interface Pv { eligibleProfit: string; deductions: string; adjustments: string; lossCarriedIn: string; reserved: string; periodResult: string; lossCovered: string; lossCarriedOut: string; distributable: string; ownerShare: string; partnerShare: string; lines: { docNo: string; adjustedProfit: string; ratio: string; linked: string; before: string; newly: string }[] }
interface S { id: string; draftRef: string; docNo: string | null; periodStart: string; periodEnd: string; status: string; distributable: string; lossCarriedOut: string; shares: { partnerId: string; kind: string; name: string; share: string; paid: string }[] }
interface Po { id: string; docNo: string; docDate: string; partner: string; partnerKind: string; amount: string; advancesDeducted: string; status: string; settlementNo: string }
interface Stmt { partner: { name: string }; netDue: string; lines: { date: string; entryNo: string; memo: string; account: string; accountName: string; debit: string; credit: string; netDue: string }[] }
export default function Partners() {
  const me = useMe(); const ov = useLoad<Ov | null>("/api/partners", null); const sets = useLoad<S[]>("/api/profit-settlements", []); const pos = useLoad<Po[]>("/api/profit-payouts", []);
  const cash = useLoad<{ id: string; name: string; currency: string; counts?: boolean; countsTowardAvailable: boolean }[]>("/api/cash-accounts", []).data.filter((c) => c.countsTowardAvailable && c.currency === "IQD");
  const { msg, busy, run } = useAction(() => { void ov.reload(); void sets.reload(); void pos.reload(); });
  const [period, setPeriod] = useState({ start: `${today().slice(0, 4)}-01-01`, end: today() }); const [reserved, setReserved] = useState(""); const [rr, setRr] = useState(""); const [adj, setAdj] = useState("0"); const [pv, setPv] = useState<Pv | null>(null);
  const [totp, setTotp] = useState(""); const [stmt, setStmt] = useState<Stmt | null>(null); const [pay, setPay] = useState<Record<string, string>>({}); const [adv, setAdv] = useState<Record<string, string>>({}); const [cashId, setCashId] = useState(""); const [reason, setReason] = useState("");
  const body = { periodStart: period.start, periodEnd: period.end, reserved: reserved || "0", reservedReason: rr || null, adjustments: adj || "0" };
  const key = () => `pay-${crypto.randomUUID()}`;
  return (<>
    <h1>الشراكة وتسوية الأرباح</h1>
    <p>الحصة 50% لكل طرف من <strong>الربح القابل للتوزيع</strong> فقط: الأرباح المؤهلة بالتحصيل − المصاريف المستحقة − الخسائر المرحّلة − المحجوز. لا يُستخدم الربح نفسه مرتين، ولا يُدفع ما يتجاوز النقد المتاح بعد الالتزامات.</p>
    {ov.data && <><div className="grid">
      <div className="card stat"><div className="label">النقد المتاح للتوزيع</div><div className="value"><span className="num">{money(ov.data.liquidity.available)}</span></div><small>نقد {money(ov.data.liquidity.cash)} − التزامات {money(ov.data.liquidity.committed)}</small></div>
      <div className="card stat"><div className="label">خسارة مرحّلة للتسوية</div><div className="value"><span className="num">{money(ov.data.lossCarriedForward)}</span></div></div>
      {ov.data.partners.map((p) => <div className="card stat" key={p.id}><div className="label">{p.kind === "OWNER" ? "المالك" : "الشريك"} — المستحق صافياً</div><div className="value"><span className="num">{money(p.netDue)}</span></div>
        <small>أرباح معتمدة {money(p.dueProfit)} • ذمة {money(p.payableToPartner)} • سلف {money(p.advancesOutstanding)}</small><br /><button onClick={() => api<Stmt>(`/api/partners/${p.id}/statement`).then(setStmt)}>كشف الحساب</button></div>)}</div></>}
    {me.user.isOwner && <div className="card row" style={{ marginTop: 12 }}><div><label htmlFor="tp">رمز المصادقة الثنائية (للاعتماد والدفع)</label><input id="tp" value={totp} onChange={(e) => setTotp(e.target.value)} dir="ltr" inputMode="numeric" maxLength={6} /></div></div>}
    <h2>1) احتساب تسوية</h2>
    <div className="card" style={{ display: "grid", gap: 12 }}>
      <div className="row"><div><label htmlFor="ps">من</label><input id="ps" type="date" value={period.start} onChange={(e) => setPeriod({ ...period, start: e.target.value })} /></div><div><label htmlFor="pe">إلى</label><input id="pe" type="date" value={period.end} onChange={(e) => setPeriod({ ...period, end: e.target.value })} /></div>
        <div><label htmlFor="rv">محجوز (اختياري)</label><input id="rv" value={reserved} onChange={(e) => setReserved(e.target.value)} dir="ltr" inputMode="decimal" /></div><div><label htmlFor="rr">سبب الحجز</label><input id="rr" value={rr} onChange={(e) => setRr(e.target.value)} /></div>
        <div><label htmlFor="ad">تسوية يدوية (±)</label><input id="ad" value={adj} onChange={(e) => setAdj(e.target.value)} dir="ltr" /></div></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}><button disabled={busy} onClick={async () => { try { setPv(await api<Pv>("/api/profit-settlements/preview", { method: "POST", body })); } catch (e) { setPv(null); await run(async () => { throw e; }, ""); } }}>معاينة</button>
        {can(me, "profit_settlement:create") && <button className="primary" disabled={busy} onClick={() => run(() => api("/api/profit-settlements", { method: "POST", body }), "حُفظت مسودة التسوية")}>حفظ كمسودة</button>}</div>
      <MsgBox msg={msg} />
      {pv && <table><tbody>
        <tr><td>أرباح مؤهلة جديدة (E)</td><td><span className="num">{money(pv.eligibleProfit)}</span></td></tr><tr><td>− مصاريف مستحقة وبنود أخرى (X)</td><td><span className="num">{money(pv.deductions)}</span></td></tr>
        <tr><td>± تسوية يدوية (A)</td><td><span className="num">{money(pv.adjustments)}</span></td></tr><tr><td>= نتيجة الفترة</td><td><strong className="num">{money(pv.periodResult)}</strong></td></tr>
        <tr><td>خسارة مرحّلة سابقة / مُغطّاة</td><td><span className="num">{money(pv.lossCarriedIn)} / {money(pv.lossCovered)}</span></td></tr><tr><td>− محجوز (R)</td><td><span className="num">{money(pv.reserved)}</span></td></tr>
        <tr><td><strong>الربح القابل للتوزيع</strong></td><td><strong className="num">{money(pv.distributable)}</strong></td></tr><tr><td>المالك / الشريك</td><td><span className="num">{money(pv.ownerShare)} / {money(pv.partnerShare)}</span></td></tr>
        <tr><td>خسارة مرحّلة للفترة التالية</td><td><span className="num">{money(pv.lossCarriedOut)}</span></td></tr></tbody></table>}
      {pv && pv.lines.length > 0 && <div className="cards-as-list" style={{ overflowX: "auto" }}><table><thead><tr><th>الفاتورة</th><th>الربح المعدّل</th><th>نسبة التحصيل</th><th>المؤهل</th><th>أُفرج سابقاً</th><th>الجديد</th></tr></thead>
        <tbody>{pv.lines.map((l) => <tr key={l.docNo}><td><span className="num">{l.docNo}</span></td><td><span className="num">{money(l.adjustedProfit)}</span></td><td><span className="num">{(Number(l.ratio) * 100).toFixed(2)}%</span></td><td><span className="num">{money(l.linked)}</span></td><td><span className="num">{money(l.before)}</span></td><td><span className="num">{money(l.newly)}</span></td></tr>)}</tbody></table></div>}
    </div>
    <h2>2) التسويات</h2>
    <div className="card cards-as-list"><table><thead><tr><th>الرقم</th><th>الفترة</th><th>القابل للتوزيع</th><th>الحصص (مدفوع/الحصة)</th><th>الحالة</th><th></th></tr></thead>
      <tbody>{sets.data.map((s) => <tr key={s.id}><td><span className="num">{s.docNo ?? s.draftRef}</span></td><td><span className="num">{s.periodStart} → {s.periodEnd}</span></td><td><span className="num">{money(s.distributable)}</span></td>
        <td>{s.shares.map((x) => <div key={x.partnerId}>{x.kind === "OWNER" ? "المالك" : "الشريك"}: <span className="num">{money(x.paid)} / {money(x.share)}</span>
          {s.status === "POSTED" && me.user.isOwner && Number(x.share) > Number(x.paid) && <span> <input aria-label="مبلغ" placeholder="مبلغ" style={{ maxWidth: 100 }} dir="ltr" value={pay[s.id + x.kind] ?? ""} onChange={(e) => setPay({ ...pay, [s.id + x.kind]: e.target.value })} />
            {x.kind === "PARTNER" && <input aria-label="سلف تُخصم" placeholder="سلف تُخصم" style={{ maxWidth: 100 }} dir="ltr" value={adv[s.id] ?? ""} onChange={(e) => setAdv({ ...adv, [s.id]: e.target.value })} />}
            <button disabled={busy || !pay[s.id + x.kind] || !cashId} onClick={() => run(() => api("/api/profit-payouts", { method: "POST", body: { settlementId: s.id, partnerKind: x.kind, amount: pay[s.id + x.kind], deductAdvances: x.kind === "PARTNER" ? adv[s.id] || "0" : "0", cashAccountId: cashId, docDate: today(), idempotencyKey: key(), totp: totp || null } }), "تم تسجيل الدفعة")}>دفع</button></span>}</div>)}</td>
        <td><StatusBadge s={s.status} /></td>
        <td>{s.status === "DRAFT" && me.user.isOwner && <button className="primary" disabled={busy} onClick={() => run(() => api(`/api/profit-settlements/${s.id}/approve`, { method: "POST", body: { totp: totp || null } }), "اعتُمدت التسوية")}>اعتماد</button>}
          {s.status === "DRAFT" && <button className="danger" disabled={busy} onClick={() => run(() => api(`/api/profit-settlements/${s.id}`, { method: "DELETE" }), "حُذفت")}>حذف</button>}
          {s.status === "POSTED" && me.user.isOwner && <button className="danger" disabled={busy || reason.length < 3} onClick={() => run(() => api(`/api/profit-settlements/${s.id}/reverse`, { method: "POST", body: { reason, totp: totp || null } }), "عُكست التسوية")}>عكس</button>}</td></tr>)}
        {sets.data.length === 0 && <tr><td colSpan={6}>لا توجد تسويات</td></tr>}</tbody></table>
      <div className="row"><div><label htmlFor="cs">الدفع من</label><select id="cs" value={cashId} onChange={(e) => setCashId(e.target.value)}><option value="">اختر…</option>{cash.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <div><label htmlFor="rs">سبب العكس (إن لزم)</label><input id="rs" value={reason} onChange={(e) => setReason(e.target.value)} /></div></div></div>
    <h2>3) الدفعات</h2>
    <div className="card cards-as-list"><table><thead><tr><th>الرقم</th><th>التاريخ</th><th>الطرف</th><th>المبلغ</th><th>سلف مخصومة</th><th>التسوية</th><th>الحالة</th></tr></thead>
      <tbody>{pos.data.map((p) => <tr key={p.id}><td><span className="num">{p.docNo}</span></td><td><span className="num">{p.docDate}</span></td><td>{p.partner}</td><td><span className="num">{money(p.amount)}</span></td><td><span className="num">{money(p.advancesDeducted)}</span></td><td><span className="num">{p.settlementNo}</span></td><td><StatusBadge s={p.status} /></td></tr>)}
        {pos.data.length === 0 && <tr><td colSpan={7}>لا توجد دفعات</td></tr>}</tbody></table></div>
    {stmt && <div className="card" style={{ marginTop: 12 }}><h2>كشف حساب: {stmt.partner.name}</h2><p>الصافي المستحق للطرف: <strong className="num">{money(stmt.netDue)}</strong></p>
      <table><thead><tr><th>التاريخ</th><th>القيد</th><th>البيان</th><th>الحساب</th><th>مدين</th><th>دائن</th><th>الصافي</th></tr></thead>
        <tbody>{stmt.lines.map((l, i) => <tr key={i}><td><span className="num">{l.date}</span></td><td><span className="num">{l.entryNo}</span></td><td>{l.memo}</td><td>{l.accountName}</td><td><span className="num">{money(l.debit)}</span></td><td><span className="num">{money(l.credit)}</span></td><td><span className="num">{money(l.netDue)}</span></td></tr>)}</tbody></table></div>}
  </>);
}
