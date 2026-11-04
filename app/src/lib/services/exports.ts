import ExcelJS from "exceljs";
import type { Tx } from "../db";
import { badRequest } from "../errors";
import { d } from "../money";
import { cashAccounts, customerStatement, payablesAging, receivablesAging, stockSummary, supplierStatement, trialBalance, journalList } from "./reports";
import { partnerStatement } from "./settlements";
import { listExpenses } from "./expenses";
import { listInvoices } from "./sales";
import { listPurchases } from "./purchases";
import { balancesReport, productMovement, purchasesReport, reportQuery, salesReport } from "./analytics";
import { listCapitalReturns } from "./capital-returns";

type Col = { header: string; key: string; width?: number; kind?: "money" | "qty" | "text" };
const FMT = { money: "#,##0;[Red]-#,##0", qty: "#,##0.######" } as const;

function addSheet(wb: ExcelJS.Workbook, title: string, cols: Col[], rows: Record<string, unknown>[], totals?: string[]) {
  const ws = wb.addWorksheet(title.slice(0, 31), { views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 16 }));
  ws.getRow(1).font = { bold: true }; ws.getRow(1).alignment = { horizontal: "center" };
  for (const r of rows) {
    const out: Record<string, unknown> = {};
    for (const c of cols) { const v = r[c.key]; out[c.key] = (c.kind === "money" || c.kind === "qty") && v !== null && v !== undefined && v !== "" ? Number(v) : v ?? ""; }
    ws.addRow(out);
  }
  cols.forEach((c, i) => { if (c.kind && c.kind !== "text") ws.getColumn(i + 1).numFmt = FMT[c.kind]; });
  if (totals && rows.length) {                                              // totals as live SUM formulas with their cached result, so Excel and the screen always agree
    const tr: Record<string, unknown> = { [cols[0]!.key]: "الإجمالي" };
    for (const k of totals) { const idx = cols.findIndex((c) => c.key === k) + 1, letter = ws.getColumn(idx).letter; tr[k] = { formula: `SUM(${letter}2:${letter}${rows.length + 1})`, result: rows.reduce((s, r) => s.plus((r[k] as string) || 0), d(0)).toNumber() }; }
    const row = ws.addRow(tr); row.font = { bold: true };
  }
  return ws;
}

export const EXPORT_KINDS = ["stock", "trial-balance", "receivables", "payables", "customer-statement", "supplier-statement", "partner-statement", "sales", "purchases", "expenses", "journal", "cash", "sales-report", "purchases-report", "debtors", "creditors", "product-movement", "capital-returns"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export async function buildExport(tx: Tx, kind: ExportKind, id?: string | null, qs: URLSearchParams = new URLSearchParams()): Promise<{ filename: string; buffer: Buffer }> {
  const wb = new ExcelJS.Workbook(); wb.creator = "النظام المحاسبي"; wb.created = new Date();
  if (kind === "stock") addSheet(wb, "المخزون", [{ header: "الكود", key: "code" }, { header: "المادة", key: "name", width: 28 }, { header: "الموقع", key: "location" }, { header: "الوحدة", key: "baseUom" }, { header: "الكمية", key: "qty", kind: "qty" }, { header: "القيمة (IQD)", key: "value", kind: "money" }], await stockSummary(tx), ["value"]);
  else if (kind === "trial-balance") { const t = await trialBalance(tx); addSheet(wb, "ميزان المراجعة", [{ header: "الحساب", key: "code" }, { header: "الاسم", key: "name", width: 30 }, { header: "مدين", key: "debit", kind: "money" }, { header: "دائن", key: "credit", kind: "money" }], t.rows as never, ["debit", "credit"]); }
  else if (kind === "receivables") addSheet(wb, "ذمم العملاء", [{ header: "الفاتورة", key: "docNo" }, { header: "العميل", key: "customer", width: 26 }, { header: "العملة", key: "currency" }, { header: "الإجمالي", key: "total", kind: "money" }, { header: "المتبقي", key: "outstanding", kind: "money" }, { header: "الاستحقاق", key: "dueDate" }, { header: "أيام التأخر", key: "daysOverdue", kind: "qty" }, { header: "الشريحة", key: "bucket" }], await receivablesAging(tx));
  else if (kind === "payables") addSheet(wb, "ذمم الموردين", [{ header: "الفاتورة", key: "docNo" }, { header: "المورد", key: "supplier", width: 26 }, { header: "العملة", key: "currency" }, { header: "الإجمالي", key: "total", kind: "money" }, { header: "المتبقي", key: "outstanding", kind: "money" }, { header: "الاستحقاق", key: "dueDate" }, { header: "أيام التأخر", key: "daysOverdue", kind: "qty" }], await payablesAging(tx));
  else if (kind === "customer-statement" || kind === "supplier-statement") {
    if (!id) throw badRequest("ID_REQUIRED");
    const s = kind === "customer-statement" ? await customerStatement(tx, id) : await supplierStatement(tx, id);
    const lines = s.lines.map((l: any) => ({ ...l, balance: l.balance }));
    addSheet(wb, "كشف الحساب", [{ header: "التاريخ", key: "date" }, { header: "القيد", key: "entryNo" }, { header: "النوع", key: "docType" }, { header: "البيان", key: "memo", width: 34 }, { header: "مدين", key: "debit", kind: "money" }, { header: "دائن", key: "credit", kind: "money" }, { header: "الرصيد", key: "balance", kind: "money" }], lines as never, ["debit", "credit"]);
  } else if (kind === "partner-statement") {
    if (!id) throw badRequest("ID_REQUIRED"); const s = await partnerStatement(tx, id);
    addSheet(wb, "كشف الشريك", [{ header: "التاريخ", key: "date" }, { header: "القيد", key: "entryNo" }, { header: "الحساب", key: "accountName", width: 24 }, { header: "البيان", key: "memo", width: 30 }, { header: "مدين", key: "debit", kind: "money" }, { header: "دائن", key: "credit", kind: "money" }, { header: "الصافي المستحق", key: "netDue", kind: "money" }], s.lines as never, ["debit", "credit"]);
  } else if (kind === "sales") addSheet(wb, "المبيعات", [{ header: "الرقم", key: "docNo" }, { header: "التاريخ", key: "docDate" }, { header: "العميل", key: "customerName", width: 26 }, { header: "العملة", key: "currency" }, { header: "الصافي", key: "net", kind: "money" }, { header: "الحالة", key: "status" }], (await listInvoices(tx)) as never);
  else if (kind === "purchases") addSheet(wb, "المشتريات", [{ header: "الرقم", key: "docNo" }, { header: "التاريخ", key: "docDate" }, { header: "المورد", key: "supplierName", width: 26 }, { header: "العملة", key: "currency" }, { header: "الإجمالي", key: "total", kind: "money" }, { header: "الحالة", key: "status" }], (await listPurchases(tx)) as never);
  else if (kind === "expenses") addSheet(wb, "المصاريف", [{ header: "الرقم", key: "docNo" }, { header: "التاريخ", key: "docDate" }, { header: "التصنيف", key: "category", width: 20 }, { header: "البيان", key: "description", width: 30 }, { header: "المبلغ", key: "amount", kind: "money" }, { header: "المستحق", key: "outstanding", kind: "money" }, { header: "الحالة", key: "status" }], (await listExpenses(tx)) as never);
  else if (kind === "cash") addSheet(wb, "النقدية", [{ header: "الحساب", key: "name", width: 24 }, { header: "العملة", key: "currency" }, { header: "النوع", key: "kind" }, { header: "الرصيد", key: "balance", kind: "money" }], (await cashAccounts(tx)) as never);
  else if (kind === "journal") {
    const j = await journalList(tx, 500); const flat = (j as any[]).flatMap((e) => (e.lines ?? []).map((l: any) => ({ entryNo: e.entryNo, date: e.date, docType: e.docType, memo: e.memo, account: l.account, name: l.name, debit: l.debit, credit: l.credit })));
    addSheet(wb, "القيود", [{ header: "القيد", key: "entryNo" }, { header: "التاريخ", key: "date" }, { header: "النوع", key: "docType" }, { header: "البيان", key: "memo", width: 30 }, { header: "الحساب", key: "account" }, { header: "الاسم", key: "name", width: 24 }, { header: "مدين", key: "debit", kind: "money" }, { header: "دائن", key: "credit", kind: "money" }], flat, ["debit", "credit"]);
  }
  else if (kind === "sales-report" || kind === "purchases-report") {
    const q = reportQuery.parse(Object.fromEntries([...qs].filter(([, v]) => v))); const sales = kind === "sales-report";
    const r = sales ? await salesReport(tx, q) : await purchasesReport(tx, q);
    const first = q.group === "invoice" ? [{ header: "التاريخ", key: "date" }, { header: sales ? "العميل" : "المورد", key: "party", width: 24 }] : [];
    const cols: Col[] = [{ header: q.group === "invoice" ? "الفاتورة" : q.group === "party" ? (sales ? "العميل" : "المورد") : q.group === "product" ? "المادة" : "الشهر", key: "label", width: 30 }, ...first, { header: "عدد المستندات", key: "docs", kind: "qty" }, { header: "الكمية", key: "qty", kind: "qty" },
      ...(sales ? [{ header: "المبيعات", key: "gross", kind: "money" as const }, { header: "المرتجعات", key: "returns", kind: "money" as const }, { header: "الصافي", key: "net", kind: "money" as const }, { header: "التكلفة", key: "cost", kind: "money" as const }, { header: "الربح", key: "profit", kind: "money" as const }, { header: "الهامش %", key: "margin", kind: "qty" as const }]
        : [{ header: "قيمة البضاعة", key: "goods", kind: "money" as const }, { header: "مصاريف الشراء", key: "charges", kind: "money" as const }, { header: "المرتجعات", key: "returns", kind: "money" as const }, { header: "الصافي", key: "net", kind: "money" as const }])];
    addSheet(wb, sales ? "تقرير المبيعات" : "تقرير المشتريات", cols, r.rows as never, cols.filter((c) => c.kind === "money").map((c) => c.key));
  } else if (kind === "debtors" || kind === "creditors") {
    const r = await balancesReport(tx, kind, { partyId: qs.get("partyId") || undefined, overdueOnly: qs.get("overdue") === "1", summary: qs.get("summary") === "1" });
    if (r.mode === "summary") addSheet(wb, kind === "debtors" ? "المدينون" : "الدائنون", [{ header: "الجهة", key: "party", width: 28 }, { header: "العملة", key: "currency" }, { header: "عدد الفواتير", key: "docs", kind: "qty" }, { header: "المتبقي", key: "outstanding", kind: "money" }, { header: "أقصى تأخر (يوم)", key: "maxOverdue", kind: "qty" }], r.rows as never);
    else addSheet(wb, kind === "debtors" ? "المدينون" : "الدائنون", [{ header: "الفاتورة", key: "docNo" }, { header: "الجهة", key: "party", width: 28 }, { header: "العملة", key: "currency" }, { header: "الإجمالي", key: "total", kind: "money" }, { header: "المتبقي", key: "outstanding", kind: "money" }, { header: "الاستحقاق", key: "dueDate" }, { header: "أيام التأخر", key: "daysOverdue", kind: "qty" }], r.rows as never);
  } else if (kind === "product-movement") {
    const pid = qs.get("productId"); if (!pid) throw badRequest("ID_REQUIRED"); const m = await productMovement(tx, pid, qs.get("from") || undefined, qs.get("to") || undefined);
    addSheet(wb, "حركة صنف", [{ header: "التاريخ", key: "movedAt", width: 22 }, { header: "الحركة", key: "type" }, { header: "المستند", key: "docType" }, { header: "الموقع", key: "location" }, { header: "الكمية", key: "qty", kind: "qty" }, { header: "التكلفة", key: "cost", kind: "money" }, { header: "الرصيد", key: "balance", kind: "qty" }], m.rows as never);
  } else if (kind === "capital-returns") {
    const rows = await listCapitalReturns(tx, { from: qs.get("from") || undefined, to: qs.get("to") || undefined, q: qs.get("q") || undefined });
    addSheet(wb, "إرجاع رأس المال", [{ header: "الرقم", key: "docNo" }, { header: "التاريخ والوقت", key: "returnedAt", width: 22 }, { header: "المستلم", key: "recipientName", width: 26 }, { header: "العملة", key: "currency" }, { header: "المبلغ", key: "amount", kind: "money" }, { header: "رقم الوصل", key: "refNo" }, { header: "الطريقة", key: "method" }, { header: "ملاحظات", key: "note", width: 30 }], rows.map((r) => ({ ...r, returnedAt: new Date(r.returnedAt as Date).toISOString().replace("T", " ").slice(0, 16) })) as never);
  }
  return { filename: `${kind}-${new Date().toISOString().slice(0, 10)}.xlsx`, buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
}
