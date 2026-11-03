"use client";
import { useParams } from "next/navigation";
import { Loading, M, Sheet, usePrint } from "@/components/print";

type Row = Record<string, string | number | null>;
const CFG: Record<string, { url: string; title: string; cols: [string, string, ("m" | "t")?][] ; pick?: (d: any) => Row[] }> = {
  stock: { url: "/api/stock", title: "تقرير المخزون (FIFO)", cols: [["code", "الكود"], ["name", "المادة"], ["location", "الموقع"], ["qty", "الكمية", "m"], ["value", "القيمة (IQD)", "m"]] },
  "trial-balance": { url: "/api/reports/trial-balance", title: "ميزان المراجعة", pick: (d) => d.rows, cols: [["code", "الحساب"], ["name", "الاسم"], ["debit", "مدين", "m"], ["credit", "دائن", "m"]] },
  receivables: { url: "/api/reports/receivables", title: "أعمار ديون العملاء", cols: [["docNo", "الفاتورة"], ["customer", "العميل"], ["outstanding", "المتبقي", "m"], ["dueDate", "الاستحقاق"], ["daysOverdue", "أيام التأخر"], ["bucket", "الشريحة"]] },
  payables: { url: "/api/reports/payables", title: "أعمار ديون الموردين", cols: [["docNo", "الفاتورة"], ["supplier", "المورد"], ["outstanding", "المتبقي", "m"], ["dueDate", "الاستحقاق"], ["daysOverdue", "أيام التأخر"]] },
  expenses: { url: "/api/expenses", title: "تقرير المصاريف", cols: [["docNo", "الرقم"], ["docDate", "التاريخ"], ["category", "التصنيف"], ["description", "البيان"], ["amount", "المبلغ", "m"], ["status", "الحالة"]] },
};
export default function PrintReport() {
  const { kind } = useParams<{ kind: string }>(); const cfg = CFG[kind]; const { data, co, err } = usePrint<any>(cfg?.url ?? "/api/company");
  if (!cfg || !data || !co) return <Loading err={err} />;
  const rows: Row[] = cfg.pick ? cfg.pick(data) : data;
  const totals = cfg.cols.filter((c) => c[2] === "m" && ["value", "debit", "credit", "outstanding", "amount"].includes(c[0]));
  return (<Sheet co={co} title={cfg.title} pdfPath={`/print/report/${kind}`} meta={[["بتاريخ", new Date().toISOString().slice(0, 10)]]} signer={["أعدّه", "راجعه", "اعتمده"]}>
    <table><thead><tr>{cfg.cols.map((c) => <th key={c[0]}>{c[1]}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{cfg.cols.map((c) => <td key={c[0]}>{c[2] === "m" ? <M v={r[c[0]] as string} /> : <span className={/code|docNo|Date|date/.test(c[0]) ? "num" : ""}>{String(r[c[0]] ?? "")}</span>}</td>)}</tr>)}
        {totals.length > 0 && <tr style={{ fontWeight: 700 }}>{cfg.cols.map((c, i) => <td key={c[0]}>{i === 0 ? "الإجمالي" : totals.some((t) => t[0] === c[0]) ? <M v={String(rows.reduce((s, r) => s + Number(r[c[0]] ?? 0), 0))} /> : ""}</td>)}</tr>}</tbody></table></Sheet>);
}
