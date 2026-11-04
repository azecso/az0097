"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Loading, M, Sheet, usePrint } from "@/components/print";
import { GROUP_LABEL, TYPE_TITLE, apiOf, colsOf, type RType } from "@/lib/report-config";

function Inner() {
  const sp = useSearchParams(); const type = (sp.get("type") ?? "sales") as RType; const group = sp.get("group") ?? "invoice"; const summary = sp.get("summary") === "1";
  const q = new URLSearchParams(sp); q.delete("type");
  const { data, co, err } = usePrint<any>(TYPE_TITLE[type] ? apiOf(type, q.toString()) : "/api/company");
  if (!TYPE_TITLE[type] || !data || !co) return <Loading err={err} />;
  const cols = colsOf(type, group, summary); const rows: any[] = data.rows ?? []; const tot = data.totals;
  const STATUS_AR: Record<string, string> = { PAID: "مسدّد بالكامل", PARTIAL: "مسدّد جزئياً", UNPAID: "غير مسدّد" };
  const cell = (v: unknown, kind?: string) => (typeof v === "string" && STATUS_AR[v] ? <span>{STATUS_AR[v]}</span> : v === null || v === undefined || v === "" ? "—" : kind === "money" ? <M v={v as string} /> : kind === "qty" ? <span className="num">{Number(v).toLocaleString("en-US", { maximumFractionDigits: 4 })}</span> : <span>{String(v)}</span>);
  const meta: [string, string | null][] = [["بتاريخ", new Date().toISOString().slice(0, 10)], ["من", sp.get("from")], ["إلى", sp.get("to")], ["العرض", type === "sales" || type === "purchases" ? GROUP_LABEL[group] ?? null : summary ? "ملخص" : null], ["العملة", type === "sales" || type === "purchases" ? "IQD (أساسية)" : null]];
  return (<Sheet co={co} title={TYPE_TITLE[type]} pdfPath={`/print/analytics?${sp.toString()}`} meta={meta as never} signer={["أعدّه", "راجعه", "اعتمده"]}>
    <table><thead><tr>{cols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c.key}>{cell(r[c.key], c.kind)}</td>)}</tr>)}
        {(type === "sales" || type === "purchases") && tot && rows.length > 0 && <tr style={{ fontWeight: 700 }}>{cols.map((c, i) => <td key={c.key}>{i === 0 ? "الإجمالي" : c.key in tot ? cell(tot[c.key], c.kind) : ""}</td>)}</tr>}</tbody></table>
    {Array.isArray(tot) && <p>الإجمالي: {tot.map((t: any) => <b key={t.currency}>{type === "customers" ? <>مبيعات <M v={t.sales} /> · مسدَّد <M v={t.paid} /> · متبقٍ <M v={t.remaining} /></> : <M v={t.total} />} {t.currency} &nbsp;</b>)}</p>}
  </Sheet>);
}
export default function PrintAnalytics() { return <Suspense fallback={<Loading err="" />}><Inner /></Suspense>; }
