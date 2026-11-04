/** Shared by the on-screen reports page and its A4 print page. Money columns are formatted, never summed in floats. */
export type ColDef = { key: string; label: string; kind?: "money" | "qty" | "text" };
export type RType = "sales" | "purchases" | "debtors" | "creditors" | "movement";
export const TYPE_TITLE: Record<RType, string> = { sales: "تقرير المبيعات", purchases: "تقرير المشتريات", debtors: "المدينون (ذمم العملاء)", creditors: "الدائنون (ذمم الموردين)", movement: "حركة صنف" };
export const GROUP_LABEL: Record<string, string> = { invoice: "تفصيلي (فاتورة بفاتورة)", party: "حسب الجهة", product: "حسب المادة", month: "حسب الشهر" };
export function apiOf(t: RType, qs: string) {
  const p = new URLSearchParams(qs);
  if (t === "sales" || t === "purchases") return `/api/reports/${t}?${qs}`;
  if (t === "movement") return `/api/reports/product-movement?${qs}`;
  p.set("side", t); return `/api/reports/balances?${p}`;
}
export function exportOf(t: RType, qs: string) {
  const kind = { sales: "sales-report", purchases: "purchases-report", debtors: "debtors", creditors: "creditors", movement: "product-movement" }[t];
  return `/api/export/${kind}?${qs}`;
}
export function colsOf(t: RType, group: string, summary: boolean): ColDef[] {
  const who = t === "sales" ? "العميل" : "المورد";
  if (t === "sales" || t === "purchases") {
    const head: ColDef[] = [{ key: "label", label: group === "invoice" ? "الفاتورة" : group === "party" ? who : group === "product" ? "المادة" : "الشهر" }];
    if (group === "invoice") head.push({ key: "date", label: "التاريخ" }, { key: "party", label: who });
    head.push({ key: "docs", label: "المستندات", kind: "qty" }, { key: "qty", label: "الكمية", kind: "qty" });
    return t === "sales" ? [...head, { key: "gross", label: "المبيعات", kind: "money" }, { key: "returns", label: "المرتجعات", kind: "money" }, { key: "net", label: "الصافي", kind: "money" }, { key: "cost", label: "التكلفة", kind: "money" }, { key: "profit", label: "الربح", kind: "money" }, { key: "margin", label: "الهامش %", kind: "qty" }]
      : [...head, { key: "goods", label: "قيمة البضاعة", kind: "money" }, { key: "charges", label: "مصاريف الشراء", kind: "money" }, { key: "returns", label: "المرتجعات", kind: "money" }, { key: "net", label: "الصافي", kind: "money" }];
  }
  if (t === "movement") return [{ key: "movedAt", label: "التاريخ" }, { key: "type", label: "الحركة" }, { key: "location", label: "الموقع" }, { key: "qty", label: "الكمية", kind: "qty" }, { key: "cost", label: "التكلفة", kind: "money" }, { key: "balance", label: "الرصيد", kind: "qty" }];
  return summary ? [{ key: "party", label: "الجهة" }, { key: "currency", label: "العملة" }, { key: "docs", label: "عدد الفواتير", kind: "qty" }, { key: "outstanding", label: "المتبقي", kind: "money" }, { key: "maxOverdue", label: "أقصى تأخر (يوم)", kind: "qty" }]
    : [{ key: "docNo", label: "الفاتورة" }, { key: "party", label: "الجهة" }, { key: "currency", label: "العملة" }, { key: "total", label: "الإجمالي", kind: "money" }, { key: "outstanding", label: "المتبقي", kind: "money" }, { key: "dueDate", label: "الاستحقاق" }, { key: "daysOverdue", label: "أيام التأخر", kind: "qty" }];
}
/** Totals line from the server payload (already Decimal-exact). */
export function totalsOf(t: RType, data: any): Record<string, string> | null {
  if (t === "sales" || t === "purchases") return data?.totals ?? null;
  return null;
}
