"use client";
import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Dl, OfficialSheet, useWho } from "@/components/official-sheet";
import { Loading, usePrint } from "@/components/print";
import { fmtCell, type RCol, type RResult } from "@/lib/report-format";

function Inner() {
  const { id } = useParams<{ id: string }>(); const sp = useSearchParams(); const qs = sp.toString(); const who = useWho();
  const { data: r, co, err } = usePrint<RResult>(`/api/reports2/${id}${qs ? `?${qs}` : ""}`);
  if (!r) return <Loading err={err} />;
  const info: [string, string | null, boolean?][] = [["بتاريخ", new Date().toISOString().slice(0, 10), true], ...Object.entries(r.filters).map(([k, v]) => [k, v, true] as [string, string, boolean])];
  return (<OfficialSheet co={co} who={who} title={r.title} titleEn="REPORT" pdfPath={`/print/fin/${id}${qs ? `?${qs}` : ""}`} leftLabel="المراجعة والاعتماد" wide
    boxes={<Dl title="بيانات التقرير" rows={info.filter((x) => x[1]) as [string, string, boolean?][]} />}
    final={<p style={{ fontSize: 12 }}>{r.definition} {r.notes.join(" • ")}</p>}>
    <table className="items"><thead><tr>{r.columns.map((c: RCol) => <th key={c.key}>{c.label}</th>)}</tr></thead>
      <tbody>{r.rows.map((row, i) => <tr key={i} style={row.bold ? { fontWeight: 700 } : undefined}>{r.columns.map((c: RCol) => <td key={c.key} className={c.kind === "money" ? "e" : undefined}>{fmtCell(row, c)}</td>)}</tr>)}
        {r.totals.map((t, i) => <tr key={`t${i}`} style={{ fontWeight: 700 }}>{r.columns.map((c: RCol) => <td key={c.key} className={c.kind === "money" ? "e" : undefined}>{fmtCell(t, c)}</td>)}</tr>)}</tbody></table>
  </OfficialSheet>);
}
export default function PrintReport() { return <Suspense fallback={<Loading err="" />}><Inner /></Suspense>; }
