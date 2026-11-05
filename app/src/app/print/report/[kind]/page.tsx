"use client";
import { useParams } from "next/navigation";
import Decimal from "decimal.js";
import { Dl, OfficialSheet, useWho } from "@/components/official-sheet";
import { Loading, M, usePrint } from "@/components/print";

type Row = Record<string, string | number | null>;
const CFG: Record<string, { url: string; title: string; en: string; cols: [string, string, ("m" | "t")?][] ; pick?: (d: any) => Row[] }> = {
  stock: { url: "/api/stock", title: "تقرير المخزون (FIFO)", en: "STOCK REPORT", cols: [["code", "الكود"], ["name", "المادة"], ["location", "الموقع"], ["qty", "الكمية", "m"], ["value", "القيمة (IQD)", "m"]] },
  "trial-balance": { url: "/api/reports/trial-balance", title: "ميزان المراجعة", en: "TRIAL BALANCE", pick: (d) => d.rows, cols: [["code", "الحساب"], ["name", "الاسم"], ["debit", "مدين", "m"], ["credit", "دائن", "m"]] },
  receivables: { url: "/api/reports/receivables", title: "أعمار ديون العملاء", en: "RECEIVABLES AGING", cols: [["docNo", "الفاتورة"], ["customer", "العميل"], ["outstanding", "المتبقي", "m"], ["dueDate", "الاستحقاق"], ["daysOverdue", "أيام التأخر"], ["bucket", "الشريحة"]] },
  payables: { url: "/api/reports/payables", title: "أعمار ديون الموردين", en: "PAYABLES AGING", cols: [["docNo", "الفاتورة"], ["supplier", "المورد"], ["outstanding", "المتبقي", "m"], ["dueDate", "الاستحقاق"], ["daysOverdue", "أيام التأخر"]] },
  expenses: { url: "/api/expenses", title: "تقرير المصاريف", en: "EXPENSES REPORT", cols: [["docNo", "الرقم"], ["docDate", "التاريخ"], ["category", "التصنيف"], ["description", "البيان"], ["amount", "المبلغ", "m"], ["status", "الحالة"]] },
};
export default function PrintReport() {
  const { kind } = useParams<{ kind: string }>(); const cfg = CFG[kind]; const { data, co, err } = usePrint<any>(cfg?.url ?? "/api/company"); const who = useWho();
  if (!cfg || !data) return <Loading err={err} />;
  const rows: Row[] = cfg.pick ? cfg.pick(data) : data;
  const totals = cfg.cols.filter((c) => c[2] === "m" && ["value", "debit", "credit", "outstanding", "amount"].includes(c[0]));
  const sum = (key: string) => rows.reduce((s, r) => s.plus(new Decimal(String(r[key] ?? 0) || 0)), new Decimal(0)).toString();
  return (<OfficialSheet co={co} who={who} title={cfg.title} titleEn={cfg.en} pdfPath={`/print/report/${kind}`} leftLabel="المراجعة والاعتماد" wide
    boxes={<Dl title="بيانات التقرير" rows={[["بتاريخ", new Date().toISOString().slice(0, 10), true], ["عدد السجلات", String(rows.length), true]]} />}>
    <table className="items"><thead><tr>{cfg.cols.map((c) => <th key={c[0]}>{c[1]}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{cfg.cols.map((c) => <td key={c[0]} className={c[2] === "m" ? "e" : undefined}>{c[2] === "m" ? <M v={r[c[0]] as string} /> : <span className={/code|docNo|Date|date/.test(c[0]) ? "num" : ""}>{String(r[c[0]] ?? "")}</span>}</td>)}</tr>)}
        {totals.length > 0 && <tr style={{ fontWeight: 700 }}>{cfg.cols.map((c, i) => <td key={c[0]} className={c[2] === "m" ? "e" : undefined}>{i === 0 ? "الإجمالي" : totals.some((t) => t[0] === c[0]) ? <M v={sum(c[0])} /> : ""}</td>)}</tr>}</tbody></table>
  </OfficialSheet>);
}
