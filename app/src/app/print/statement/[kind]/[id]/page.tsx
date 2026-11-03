"use client";
import { useParams } from "next/navigation";
import { Loading, M, Sheet, usePrint } from "@/components/print";

interface S { customer?: { name: string }; supplier?: { name: string }; partner?: { name: string }; balance?: string; netDue?: string; unappliedCredit?: string; lines: { date: string; entryNo: string; memo: string | null; accountName?: string; debit: string; credit: string; balance?: string; netDue?: string }[] }
const URL: Record<string, (id: string) => string> = { customer: (id) => `/api/customers/${id}/statement`, supplier: (id) => `/api/contacts/${id}/statement`, partner: (id) => `/api/partners/${id}/statement` };
const TITLE: Record<string, string> = { customer: "كشف حساب عميل", supplier: "كشف حساب مورد", partner: "كشف حساب شريك" };
export default function PrintStatement() {
  const { kind, id } = useParams<{ kind: string; id: string }>(); const { data: d, co, err } = usePrint<S>(URL[kind]?.(id) ?? "/api/company");
  if (!d || !co) return <Loading err={err} />;
  const who = d.customer?.name ?? d.supplier?.name ?? d.partner?.name; const bal = d.balance ?? d.netDue;
  return (<Sheet co={co} title={TITLE[kind] ?? "كشف حساب"} pdfPath={`/print/statement/${kind}/${id}`} meta={[["الطرف", who], ["بتاريخ", new Date().toISOString().slice(0, 10)], ["الرصيد", bal ? Number(bal).toLocaleString("en-US") + " IQD" : null]]}>
    <table><thead><tr><th>التاريخ</th><th>القيد</th><th>البيان</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead>
      <tbody>{d.lines.map((l, i) => <tr key={i}><td className="num">{l.date}</td><td className="num">{l.entryNo}</td><td>{l.accountName ? `${l.accountName} — ` : ""}{l.memo}</td><td><M v={l.debit} /></td><td><M v={l.credit} /></td><td><M v={l.balance ?? l.netDue} /></td></tr>)}</tbody></table>
    {d.unappliedCredit && Number(d.unappliedCredit) > 0 && <p>رصيد دائن غير مستخدم للعميل: <M v={d.unappliedCredit} /></p>}</Sheet>);
}
