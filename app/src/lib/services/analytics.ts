import { z } from "zod";
import Decimal from "decimal.js";
import type { Tx } from "../db";
import { d } from "../money";
import { dateStr, uuid } from "./common";
import { payablesAging, receivablesAging } from "./reports";

/** Filtered, grouped reports. All money is the IQD base value stored on the posted documents; sums use NUMERIC in SQL and Decimal here. */
export const GROUPS = ["invoice", "party", "product", "month"] as const;
export const reportQuery = z.object({
  from: dateStr.optional(), to: dateStr.optional(), partyId: uuid.optional(), productId: uuid.optional(), group: z.enum(GROUPS).default("invoice"),
});
export type ReportQuery = z.infer<typeof reportQuery>;
const dec = (rows: Record<string, unknown>[], keys: string[]) => {
  const t: Record<string, Decimal> = Object.fromEntries(keys.map((k) => [k, d(0)]));
  for (const r of rows) for (const k of keys) if (r[k] !== null && r[k] !== undefined) t[k] = t[k]!.plus(d(String(r[k])));
  return Object.fromEntries(keys.map((k) => [k, t[k]!.toString()]));
};

export async function salesReport(tx: Tx, q: ReportQuery) {
  const rows = await tx`
    WITH l AS (
      SELECT si.id AS inv_id, si.doc_no, si.doc_date, c.id AS party_id, c.name AS party, sl.product_id, p.code AS pcode, p.name AS pname,
        sl.qty_base, sl.net_line_base AS net,
        COALESCE((SELECT sum(dl.cost_base) FROM delivery_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_id WHERE dl.sales_line_id = sl.id AND dn.status = 'POSTED'), 0) AS cogs,
        COALESCE((SELECT sum(rl.value_base) FROM sales_return_lines rl JOIN sales_returns r ON r.id = rl.return_id WHERE rl.sales_line_id = sl.id AND r.status = 'POSTED'), 0) AS ret,
        COALESCE((SELECT sum(rl.cost_base) FROM sales_return_lines rl JOIN sales_returns r ON r.id = rl.return_id WHERE rl.sales_line_id = sl.id AND r.status = 'POSTED'), 0) AS ret_cost,
        COALESCE((SELECT sum(rl.qty_base) FROM sales_return_lines rl JOIN sales_returns r ON r.id = rl.return_id WHERE rl.sales_line_id = sl.id AND r.status = 'POSTED'), 0) AS ret_qty
      FROM sales_invoices si JOIN sales_lines sl ON sl.invoice_id = si.id JOIN contacts c ON c.id = si.customer_id JOIN products p ON p.id = sl.product_id
      WHERE si.status = 'POSTED' AND NOT si.is_opening
        AND (${q.from ?? null}::date IS NULL OR si.doc_date >= ${q.from ?? null}::date) AND (${q.to ?? null}::date IS NULL OR si.doc_date <= ${q.to ?? null}::date)
        AND (${q.partyId ?? null}::uuid IS NULL OR si.customer_id = ${q.partyId ?? null}::uuid) AND (${q.productId ?? null}::uuid IS NULL OR sl.product_id = ${q.productId ?? null}::uuid))
    SELECT CASE ${q.group} WHEN 'party' THEN party_id::text WHEN 'product' THEN product_id::text WHEN 'month' THEN to_char(doc_date, 'YYYY-MM') ELSE inv_id::text END AS key,
           CASE ${q.group} WHEN 'party' THEN min(party) WHEN 'product' THEN min(pcode) || ' — ' || min(pname) WHEN 'month' THEN to_char(min(doc_date), 'YYYY-MM') ELSE min(doc_no) END AS label,
           CASE WHEN ${q.group} = 'invoice' THEN min(doc_date)::text END AS date, CASE WHEN ${q.group} = 'invoice' THEN min(party) END AS party,
           count(DISTINCT inv_id)::int AS docs, sum(qty_base - ret_qty)::text AS qty, sum(net)::text AS gross, sum(ret)::text AS returns, sum(net - ret)::text AS net,
           sum(cogs - ret_cost)::text AS cost, sum((net - ret) - (cogs - ret_cost))::text AS profit
    FROM l GROUP BY 1
    ORDER BY CASE WHEN ${q.group} = 'invoice' THEN min(doc_date)::text ELSE NULL END DESC, CASE WHEN ${q.group} IN ('party','product') THEN sum(net - ret) END DESC NULLS LAST, label DESC`;
  const withMargin = rows.map((r) => ({ ...r, margin: d(r.net as string).gt(0) ? d(r.profit as string).div(d(r.net as string)).mul(100).toDecimalPlaces(2).toString() : null }));
  const totals = dec(rows as never, ["qty", "gross", "returns", "net", "cost", "profit"]);
  return { group: q.group, rows: withMargin, totals: { ...totals, docs: rows.reduce((s, r) => s + (r.docs as number), 0) }, currency: "IQD" };
}

export async function purchasesReport(tx: Tx, q: ReportQuery) {
  const product = q.group === "product";
  const rows = await tx`
    WITH l AS (
      SELECT po.id AS doc_id, po.doc_no, po.doc_date, c.id AS party_id, c.name AS party, pl.product_id, p.code AS pcode, p.name AS pname,
        pl.qty_base, pl.line_total_base AS goods, pl.landed_cost_base AS landed
      FROM purchase_orders po JOIN purchase_lines pl ON pl.purchase_id = po.id JOIN contacts c ON c.id = po.supplier_id JOIN products p ON p.id = pl.product_id
      WHERE po.status = 'POSTED' AND NOT po.is_opening
        AND (${q.from ?? null}::date IS NULL OR po.doc_date >= ${q.from ?? null}::date) AND (${q.to ?? null}::date IS NULL OR po.doc_date <= ${q.to ?? null}::date)
        AND (${q.partyId ?? null}::uuid IS NULL OR po.supplier_id = ${q.partyId ?? null}::uuid) AND (${q.productId ?? null}::uuid IS NULL OR pl.product_id = ${q.productId ?? null}::uuid)),
    k AS (SELECT *, CASE ${q.group} WHEN 'party' THEN party_id::text WHEN 'product' THEN product_id::text WHEN 'month' THEN to_char(doc_date, 'YYYY-MM') ELSE doc_id::text END AS key FROM l),
    hdr AS (SELECT DISTINCT key, doc_id FROM k)
    SELECT k.key,
           CASE ${q.group} WHEN 'party' THEN min(party) WHEN 'product' THEN min(pcode) || ' — ' || min(pname) WHEN 'month' THEN to_char(min(doc_date), 'YYYY-MM') ELSE min(doc_no) END AS label,
           CASE WHEN ${q.group} = 'invoice' THEN min(doc_date)::text END AS date, CASE WHEN ${q.group} = 'invoice' THEN min(party) END AS party,
           count(DISTINCT doc_id)::int AS docs, sum(qty_base)::text AS qty, sum(goods)::text AS goods,
           CASE WHEN ${product} THEN NULL ELSE COALESCE((SELECT sum(ch.amount_base) FROM purchase_charges ch WHERE ch.purchase_id IN (SELECT doc_id FROM hdr WHERE hdr.key = k.key)), 0)::text END AS charges,
           CASE WHEN ${product} THEN NULL ELSE COALESCE((SELECT sum(r.total_base) FROM purchase_returns r WHERE r.status = 'POSTED' AND r.purchase_id IN (SELECT doc_id FROM hdr WHERE hdr.key = k.key)), 0)::text END AS returns
    FROM k GROUP BY k.key ORDER BY CASE WHEN ${q.group} IN ('invoice','month') THEN min(doc_date)::text END DESC NULLS LAST, sum(goods) DESC`;
  const t = dec(rows as never, ["qty", "goods", "charges", "returns"]);
  const netOf = (r: Record<string, unknown>) => d(r.goods as string).plus(r.charges ? d(r.charges as string) : 0).minus(r.returns ? d(r.returns as string) : 0).toString();
  return { group: q.group, rows: rows.map((r) => ({ ...r, net: netOf(r) })), totals: { ...t, net: d(t.goods!).plus(t.charges!).minus(t.returns!).toString(), docs: rows.reduce((s, r) => s + (r.docs as number), 0) }, currency: "IQD" };
}

/** Debtors (customers) / creditors (suppliers): detail = invoice by invoice; summary = one row per party and currency. */
export async function balancesReport(tx: Tx, side: "debtors" | "creditors", q: { partyId?: string; overdueOnly?: boolean; summary?: boolean }) {
  const all = (side === "debtors" ? await receivablesAging(tx) : await payablesAging(tx)) as unknown as Record<string, any>[];
  const nameKey = side === "debtors" ? "customer" : "supplier"; const idKey = side === "debtors" ? "customerId" : "supplierId";
  let rows = all.filter((r) => d(r.outstanding).gt(0));
  if (q.partyId) rows = rows.filter((r) => r[idKey] === q.partyId);
  if (q.overdueOnly) rows = rows.filter((r) => Number(r.daysOverdue) > 0);
  const detail = rows.map((r) => ({ docNo: r.docNo, party: r[nameKey], currency: r.currency, total: r.total, outstanding: r.outstanding, dueDate: r.dueDate, daysOverdue: Number(r.daysOverdue) }));
  const byCur = new Map<string, Decimal>();
  for (const r of detail) byCur.set(r.currency, (byCur.get(r.currency) ?? d(0)).plus(d(r.outstanding)));
  const totals = [...byCur].map(([currency, total]) => ({ currency, total: total.toString() })).sort((a, b) => a.currency.localeCompare(b.currency));
  if (!q.summary) return { side, mode: "detail" as const, rows: detail, totals };
  const m = new Map<string, { party: string; currency: string; docs: number; outstanding: Decimal; maxOverdue: number }>();
  for (const r of detail) { const k = `${r.party}|${r.currency}`; const e = m.get(k) ?? { party: r.party, currency: r.currency, docs: 0, outstanding: d(0), maxOverdue: 0 }; e.docs += 1; e.outstanding = e.outstanding.plus(d(r.outstanding)); e.maxOverdue = Math.max(e.maxOverdue, r.daysOverdue); m.set(k, e); }
  return { side, mode: "summary" as const, rows: [...m.values()].map((e) => ({ party: e.party, currency: e.currency, docs: e.docs, outstanding: e.outstanding.toString(), maxOverdue: e.maxOverdue })).sort((a, b) => d(b.outstanding).comparedTo(d(a.outstanding))), totals };
}

/** Product card: opening balance before `from`, then every stock movement with running balance (base unit, IQD cost). */
export async function productMovement(tx: Tx, productId: string, from?: string, to?: string) {
  const [p] = await tx`SELECT id, code, name, base_uom AS "baseUom" FROM products WHERE id = ${productId}`;
  if (!p) return { product: null, opening: { qty: "0", cost: "0" }, rows: [], totals: { qtyIn: "0", qtyOut: "0" } };
  const [o] = await tx`SELECT COALESCE(sum(qty_base), 0)::text AS qty, COALESCE(sum(cost_base), 0)::text AS cost FROM stock_movements WHERE product_id = ${productId} AND ${from ?? null}::date IS NOT NULL AND moved_at < ${from ?? null}::date`;
  const mv = await tx`SELECT m.moved_at::text AS "movedAt", m.movement_type AS type, m.doc_type AS "docType", sl.name AS location, m.qty_base::text AS qty, m.cost_base::text AS cost
    FROM stock_movements m JOIN stock_locations sl ON sl.id = m.location_id
    WHERE m.product_id = ${productId} AND (${from ?? null}::date IS NULL OR m.moved_at >= ${from ?? null}::date) AND (${to ?? null}::date IS NULL OR m.moved_at < (${to ?? null}::date + 1))
    ORDER BY m.moved_at, m.created_at`;
  let bal = d(o!.qty); let qin = d(0), qout = d(0);
  const rows = mv.map((r) => { const q = d(r.qty as string); if (q.gt(0)) qin = qin.plus(q); else qout = qout.plus(q.abs()); bal = bal.plus(q); return { ...r, balance: bal.toString() }; });
  return { product: p, opening: o!, rows, totals: { qtyIn: qin.toString(), qtyOut: qout.toString() }, closing: bal.toString() };
}
