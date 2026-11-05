"use client";
import { useParams } from "next/navigation";
import { Dl, OfficialSheet, useWho } from "@/components/official-sheet";
import { Loading, M, usePrint } from "@/components/print";

interface S { customer?: { name: string }; supplier?: { name: string }; partner?: { name: string }; balance?: string; netDue?: string; unappliedCredit?: string; lines: { date: string; entryNo: string; memo: string | null; accountName?: string; debit: string; credit: string; balance?: string; netDue?: string }[] }
const URL: Record<string, (id: string) => string> = { customer: (id) => `/api/customers/${id}/statement`, supplier: (id) => `/api/contacts/${id}/statement`, partner: (id) => `/api/partners/${id}/statement` };
const TITLE: Record<string, [string, string]> = { customer: ["كشف حساب عميل", "CUSTOMER STATEMENT"], supplier: ["كشف حساب مورد", "SUPPLIER STATEMENT"], partner: ["كشف حساب شريك", "PARTNER STATEMENT"] };
export default function PrintStatement() {
  const { kind, id } = useParams<{ kind: string; id: string }>(); const { data: d, co, err } = usePrint<S>(URL[kind]?.(id) ?? "/api/company"); const who = useWho();
  if (!d) return <Loading err={err} />;
  const party = d.customer?.name ?? d.supplier?.name ?? d.partner?.name; const bal = d.balance ?? d.netDue; const t = TITLE[kind] ?? ["كشف حساب", "STATEMENT"];
  return (<OfficialSheet co={co} who={who} title={t[0]} titleEn={t[1]} pdfPath={`/print/statement/${kind}/${id}`} leftLabel="الطرف (المراجعة)" leftName={party ?? ""}
    boxes={<><Dl title="بيانات الكشف" rows={[["الطرف", party], ["بتاريخ", new Date().toISOString().slice(0, 10), true]]} />
      <Dl title="الرصيد" rows={[["الرصيد الحالي", bal ? <><M v={bal} /> IQD</> : null], ...(d.unappliedCredit && Number(d.unappliedCredit) > 0 ? [["رصيد دائن غير مستخدم", <M key="u" v={d.unappliedCredit} />] as [string, React.ReactNode]] : [])]} /></>}>
    <table className="items"><thead><tr><th style={{ width: "13%" }}>التاريخ</th><th style={{ width: "15%" }}>القيد</th><th>البيان</th><th style={{ width: "13%" }}>مدين</th><th style={{ width: "13%" }}>دائن</th><th style={{ width: "14%" }}>الرصيد</th></tr></thead>
      <tbody>{d.lines.map((l, i) => <tr key={i}><td className="c num">{l.date}</td><td className="c num">{l.entryNo}</td><td>{l.accountName ? `${l.accountName} — ` : ""}{l.memo}</td><td className="e"><M v={l.debit} /></td><td className="e"><M v={l.credit} /></td><td className="e"><M v={l.balance ?? l.netDue} /></td></tr>)}</tbody></table>
  </OfficialSheet>);
}
