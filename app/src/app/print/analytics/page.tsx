"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Dl, OfficialSheet, useWho } from "@/components/official-sheet";
import { Loading, M, usePrint } from "@/components/print";
import { GROUP_LABEL, TYPE_TITLE, apiOf, colsOf, type RType } from "@/lib/report-config";

const STATUS_AR: Record<string, string> = { PAID: "مسدّد بالكامل", PARTIAL: "مسدّد جزئياً", UNPAID: "غير مسدّد" };
function Inner() {
  const sp = useSearchParams(); const type = (sp.get("type") ?? "sales") as RType; const group = sp.get("group") ?? "invoice"; const summary = sp.get("summary") === "1";
  const q = new URLSearchParams(sp); q.delete("type"); const who = useWho();
  const { data, co, err } = usePrint<any>(TYPE_TITLE[type] ? apiOf(type, q.toString()) : "/api/company");
  if (!TYPE_TITLE[type] || !data) return <Loading err={err} />;
  const cols = colsOf(type, group, summary); const rows: any[] = data.rows ?? []; const tot = data.totals;
  const cell = (v: unknown, kind?: string) => (typeof v === "string" && STATUS_AR[v] ? <span>{STATUS_AR[v]}</span> : v === null || v === undefined || v === "" ? "—" : kind === "money" ? <M v={v as string} /> : kind === "qty" ? <span className="num">{Number(v).toLocaleString("en-US", { maximumFractionDigits: 4 })}</span> : <span>{String(v)}</span>);
  const rowsInfo: [string, string | null, boolean?][] = [["بتاريخ", new Date().toISOString().slice(0, 10), true], ["من", sp.get("from"), true], ["إلى", sp.get("to"), true], ["العرض", type === "sales" || type === "purchases" ? GROUP_LABEL[group] ?? null : summary ? "ملخص" : null], ["العملة", type === "sales" || type === "purchases" ? "IQD (أساسية)" : null]];
  return (<OfficialSheet co={co} who={who} title={TYPE_TITLE[type]} titleEn="REPORT" pdfPath={`/print/analytics?${sp.toString()}`} leftLabel="المراجعة والاعتماد" wide
    boxes={<Dl title="بيانات التقرير" rows={rowsInfo.filter((r) => r[1]) as [string, string, boolean?][]} />}
    final={type === "external" && tot && !Array.isArray(tot) ? <p>الإجمالي: مستحصل نقداً <M v={tot.cash} /> · موزَّع خارج النظام <M v={tot.external} /> (لكل شريك <M v={tot.perPartner} />)</p> : Array.isArray(tot) ? <p>الإجمالي: {tot.map((t: any) => <b key={t.currency}>{type === "customers" ? <>مبيعات <M v={t.sales} /> · مسدَّد <M v={t.paid} /> · متبقٍ <M v={t.remaining} /></> : <M v={t.total} />} {t.currency} &nbsp;</b>)}</p> : null}>
    <table className="items"><thead><tr>{cols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} className={r.status === "PAID" ? "paidrow" : undefined}>{cols.map((c) => <td key={c.key} className={c.kind === "money" ? "e" : undefined}>{cell(r[c.key], c.kind)}</td>)}</tr>)}
        {(type === "sales" || type === "purchases") && tot && rows.length > 0 && <tr style={{ fontWeight: 700 }}>{cols.map((c, i) => <td key={c.key} className={c.kind === "money" ? "e" : undefined}>{i === 0 ? "الإجمالي" : c.key in tot ? cell(tot[c.key], c.kind) : ""}</td>)}</tr>}</tbody></table>
  </OfficialSheet>);
}
export default function PrintAnalytics() { return <Suspense fallback={<Loading err="" />}><Inner /></Suspense>; }
