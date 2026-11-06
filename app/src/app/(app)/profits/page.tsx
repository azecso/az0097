"use client";
import { useRef, useState } from "react";
import Decimal from "decimal.js";
import Link from "next/link";
import { api, money, today } from "@/lib/client";
import { can, useMe } from "@/components/me";
import { MsgBox, PrintLink, useAction, useLoad } from "@/components/ui";

interface Person { kind: string; name: string; externalDistributed: string; approved: string; paid: string; advancesDeducted: string; remainingApproved: string; pending: string; available: string }
interface Payout { id: string; docNo: string; docDate: string; partner: string; partnerKind: string; amount: string; advancesDeducted: string; status: string; settlementNo?: string }
interface Ov { period: { from: string | null; to: string }; invoicedProfit: string; collectedProfit: string; releasedBefore: string; newlyEligible: string; expenses: { total: string; byAccount: { code: string; name: string; amount: string }[]; other: string };
  lossCarriedIn: string; lossCovered: string; netProfit: string; distributable: string; lossCarriedOut: string; externalDistributed: string; shares: { owner: string; partner: string }; people: Person[]; liquidity: { cash: string; committed: string; available: string }; capital: string; payouts: Payout[] }
interface Cash { id: string; name: string; currency: string; kind: string; countsTowardAvailable: boolean }
const empty: Ov = { period: { from: null, to: "" }, invoicedProfit: "0", collectedProfit: "0", releasedBefore: "0", newlyEligible: "0", expenses: { total: "0", byAccount: [], other: "0" }, lossCarriedIn: "0", lossCovered: "0", netProfit: "0", distributable: "0", lossCarriedOut: "0", externalDistributed: "0", shares: { owner: "0", partner: "0" }, people: [], liquidity: { cash: "0", committed: "0", available: "0" }, capital: "0", payouts: [] };
const R = ({ k, v, strong, cls }: { k: string; v: string; strong?: boolean; cls?: string }) => <tr className={cls} style={strong ? { fontWeight: 700 } : undefined}><td>{k}</td><td><span className="num">{money(v)}</span></td></tr>;

export default function Profits() {
  const me = useMe(); const ov = useLoad<Ov>("/api/profits", empty); const cash = useLoad<Cash[]>("/api/cash-accounts", []).data.filter((c) => c.currency === "IQD" && c.countsTowardAvailable);
  const st = useLoad<{ profitStepUp: boolean }>("/api/profits/settings", { profitStepUp: false });
  const { msg, busy, run } = useAction(() => { void ov.reload(); void st.reload(); });
  const [who, setWho] = useState<string | null>(null); const key = useRef(crypto.randomUUID()); const [last, setLast] = useState<{ id: string; docNo: string; amount: string }[]>([]); const [totp, setTotp] = useState("");
  const o = ov.data; const owner = me.user.isOwner; const net = Number(o.netProfit) < 0;
  async function withdraw(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const r = await run(() => api<{ payouts: { id: string; docNo: string; amount: string }[] }>("/api/profits/withdraw", { method: "POST", body: { partnerKind: who, amount: String(f.get("amount")), cashAccountId: String(f.get("cash")), docDate: String(f.get("date")), idempotencyKey: key.current, totp: totp || null } }), "تم صرف الأرباح وتسجيل السند");
    if (r) { setLast(r.payouts); setWho(null); key.current = crypto.randomUUID(); }
  }
  return (<>
    <h1>الأرباح والتوزيع</h1>
    <p>تُحسب الأرقام مباشرة من الفواتير والمصاريف المسجَّلة. <strong>المصاريف تُخصم من الربح</strong> وليس من رأس المال، ويُوزَّع الصافي بين صاحب المال والشريك (50/50). كل صرف يُسجَّل بسند ولا يتجاوز حصة صاحبه.</p>
    <div className="grid"><div className="card stat"><div className="label">رأس المال (لا تمسّه المصاريف)</div><div className="value"><span className="num">{money(o.capital)}</span></div></div>
      <div className="card stat"><div className="label">صافي الربح القابل للتوزيع</div><div className="value"><span className="num">{money(o.distributable)}</span></div>{net && <small>خسارة الفترة {money(o.netProfit)} (تُرحَّل)</small>}</div>
      <div className="card stat"><div className="label">النقد المتاح للصرف</div><div className="value"><span className="num">{money(o.liquidity.available)}</span></div><small>صندوق {money(o.liquidity.cash)} − التزامات {money(o.liquidity.committed)}</small></div></div>
    <MsgBox msg={msg} />
    {last.length > 0 && <div className="card" style={{ marginTop: 12 }}>تم الصرف: {last.map((p) => <span key={p.id}><span className="num">{p.docNo}</span> ({money(p.amount)}) <PrintLink path={`/print/doc/profit-payout/${p.id}`} label="طباعة السند" /> </span>)}</div>}

    <div className="card cards-as-list" style={{ marginTop: 12 }}><h2>بيان الربح{o.period.from ? ` (من ${o.period.from})` : ""} حتى {o.period.to}</h2>
      <table><tbody>
        <R k="إجمالي الربح على الفواتير (المفوتر، بعد المرتجعات)" v={o.invoicedProfit} />
        <R k="الربح المحصَّل منه حتى الآن (يحق توزيعه)" v={o.collectedProfit} />
        <R k="— منه معتمد في تسويات سابقة" v={o.releasedBefore} />
        <R k="الربح الجديد المؤهَّل في هذه الفترة" v={o.newlyEligible} strong />
        {o.expenses.byAccount.map((a) => <R key={a.code} k={`− ${a.name}`} v={a.amount} />)}
        {Number(o.expenses.other) !== 0 && <R k="− قيود أخرى مخصومة" v={o.expenses.other} />}
        <R k="إجمالي المصاريف المخصومة من الربح" v={o.expenses.total} strong />
        {Number(o.lossCarriedIn) > 0 && <R k="− خسائر مرحَّلة من فترات سابقة (المغطّى منها)" v={o.lossCovered} />}
        <R k="صافي الربح القابل للتوزيع" v={o.distributable} strong cls="paidrow" />
        <R k="حصة صاحب المال" v={o.shares.owner} /><R k="حصة الشريك" v={o.shares.partner} />
        {Number(o.externalDistributed) > 0 && <R k="للعلم: أرباح فواتير وُزّعت خارج النظام (نصفها لكل شريك — لا تدخل هذا التوزيع)" v={o.externalDistributed} />}
      </tbody></table></div>

    <h2 style={{ marginTop: 16 }}>حصص الأرباح</h2>
    <div className="grid">{o.people.map((p) => <div className="card" key={p.kind}><strong>{p.name}</strong> <small>({p.kind === "OWNER" ? "صاحب المال" : "الشريك"})</small>
      <table><tbody><R k="حصته المعتمدة" v={p.approved} /><R k="حصة الفترة الحالية (تُعتمد عند الصرف)" v={p.pending} /><R k="ما سُحب منها" v={p.paid} />{Number(p.externalDistributed) > 0 && <R k="وصله خارج النظام (للعلم)" v={p.externalDistributed} />}<R k="المتاح له للسحب" v={p.available} strong cls="paidrow" /></tbody></table>
      {owner && can(me, "profit_payout:create") && <button className="primary" disabled={busy || Number(p.available) <= 0} onClick={() => setWho(p.kind)}>صرف / سحب أرباح</button>}</div>)}</div>
    {who && owner && <form className="card row" onSubmit={withdraw} style={{ marginTop: 12 }}>
      <div><label>المستلم</label><strong>{o.people.find((p) => p.kind === who)?.name}</strong> <small>المتاح {money(o.people.find((p) => p.kind === who)?.available)}</small></div>
      <div><label htmlFor="am">المبلغ</label><input id="am" name="amount" required dir="ltr" inputMode="decimal" autoFocus /></div>
      <div><label htmlFor="ca">من صندوق</label><select id="ca" name="cash" required>{cash.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <div><label htmlFor="dt">التاريخ</label><input id="dt" name="date" type="date" defaultValue={today()} required /></div>
      {st.data.profitStepUp && <div><label htmlFor="tp">رمز المصادقة الثنائية</label><input id="tp" value={totp} onChange={(e) => setTotp(e.target.value)} dir="ltr" inputMode="numeric" /></div>}
      <button className="primary" disabled={busy}>تأكيد الصرف</button><button type="button" onClick={() => setWho(null)}>إلغاء</button></form>}

    <div className="card cards-as-list" style={{ marginTop: 12 }}><h2>سجل التوزيعات والسحوبات من الأرباح</h2>
      <table><thead><tr><th>السند</th><th>التاريخ</th><th>المستلم</th><th>المبلغ</th><th>مخصوم من السلف</th><th>الحالة</th><th></th></tr></thead>
        <tbody>{o.payouts.map((p) => <tr key={p.id}><td><span className="num">{p.docNo}</span></td><td><span className="num">{p.docDate}</span></td><td>{p.partner} <small>({p.partnerKind === "OWNER" ? "صاحب المال" : "الشريك"})</small></td><td><span className="num">{money(p.amount)}</span></td><td><span className="num">{money(p.advancesDeducted)}</span></td><td>{p.status === "POSTED" ? "مُنفَّذ" : "معكوس"}</td><td><PrintLink path={`/print/doc/profit-payout/${p.id}`} /></td></tr>)}
          {o.payouts.length === 0 && <tr><td colSpan={7}>لا توجد سحوبات بعد</td></tr>}</tbody></table>
      {o.payouts.length > 0 && <p>إجمالي المسحوب: <strong className="num">{money(o.payouts.filter((p) => p.status === "POSTED").reduce((s, p) => s.plus(p.amount), new Decimal(0)).toString())}</strong></p>}</div>

    {owner && <div className="card" style={{ marginTop: 12 }}><label><input type="checkbox" checked={st.data.profitStepUp} onChange={(e) => void run(() => api("/api/profits/settings", { method: "PUT", body: { profitStepUp: e.target.checked } }), "تم حفظ الإعداد")} /> طلب رمز المصادقة الثنائية عند صرف الأرباح (معطّل افتراضياً)</label>
      <p><Link href="/partners">للتسويات التفصيلية والسلف وكشف حساب كل طرف ←</Link></p></div>}
  </>);
}
