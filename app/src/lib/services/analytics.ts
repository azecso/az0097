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
  const flt = tx`WHERE si.status = 'POSTED' AND NOT si.is_opening
        AND (${q.from ?? null}::date IS NULL OR si.doc_date >= ${q.from ?? null}::date) AND (${q.to ?? null}::date IS NULL OR si.doc_date <= ${q.to ?? null}::date)
        AND (${q.partyId ?? null}::uuid IS NULL OR si.customer_id = ${q.partyId ?? null}::uuid) AND (${q.productId ?? null}::uuid IS NULL OR sl.product_id = ${q.productId ?? null}::uuid)`;
  // Basis: invoices dated in the period, in their CURRENT state (deliveries/returns to date). Revenue = the DELIVERED share only; cost = FIFO cost of what was delivered — an undelivered invoice cannot inflate profit.
  const rows = await tx`
    WITH l AS (
      SELECT si.id AS inv_id, si.doc_no, si.doc_date, c.id AS party_id, c.name AS party, sl.product_id, p.code AS pcode, p.name AS pname,
        sl.qty_base, sl.line_total_base AS gross, sl.line_total_base - sl.net_line_base AS disc, sl.net_line_base AS net,
        COALESCE((SELECT sum(dl.qty_base) FROM delivery_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_id WHERE dl.sales_line_id = sl.id AND dn.status = 'POSTED'), 0) AS dq,
        COALESCE((SELECT sum(dl.cost_base) FROM delivery_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_id WHERE dl.sales_line_id = sl.id AND dn.status = 'POSTED'), 0) AS cogs,
        COALESCE((SELECT sum(rl.value_base) FROM sales_return_lines rl JOIN sales_returns r ON r.id = rl.return_id WHERE rl.sales_line_id = sl.id AND r.status = 'POSTED'), 0) AS ret,
        COALESCE((SELECT sum(rl.cost_base) FROM sales_return_lines rl JOIN sales_returns r ON r.id = rl.return_id WHERE rl.sales_line_id = sl.id AND r.status = 'POSTED'), 0) AS ret_cost,
        COALESCE((SELECT sum(rl.qty_base) FROM sales_return_lines rl JOIN sales_returns r ON r.id = rl.return_id WHERE rl.sales_line_id = sl.id AND r.status = 'POSTED'), 0) AS ret_qty
      FROM sales_invoices si JOIN sales_lines sl ON sl.invoice_id = si.id JOIN contacts c ON c.id = si.customer_id JOIN products p ON p.id = sl.product_id ${flt}),
    r AS (SELECT *, CASE WHEN dq >= qty_base THEN net ELSE round(net * dq / qty_base) END AS rec FROM l)
    SELECT CASE ${q.group} WHEN 'party' THEN party_id::text WHEN 'product' THEN product_id::text WHEN 'month' THEN to_char(doc_date, 'YYYY-MM') ELSE inv_id::text END AS key,
           CASE ${q.group} WHEN 'party' THEN min(party) WHEN 'product' THEN min(pcode) || ' — ' || min(pname) WHEN 'month' THEN to_char(min(doc_date), 'YYYY-MM') ELSE min(doc_no) END AS label,
           CASE WHEN ${q.group} = 'invoice' THEN min(doc_date)::text END AS date, CASE WHEN ${q.group} = 'invoice' THEN min(party) END AS party,
           count(DISTINCT inv_id)::int AS docs, sum(qty_base - ret_qty)::text AS qty, sum(gross)::text AS gross, sum(disc)::text AS discount, sum(ret)::text AS returns, sum(net - ret)::text AS net,
           sum(rec - ret)::text AS recognized, sum(cogs - ret_cost)::text AS cost, sum((rec - ret) - (cogs - ret_cost))::text AS profit
    FROM r GROUP BY 1
    ORDER BY CASE WHEN ${q.group} = 'invoice' THEN min(doc_date)::text ELSE NULL END DESC, CASE WHEN ${q.group} IN ('party','product') THEN sum(net - ret) END DESC NULLS LAST, label DESC`;
  const [dd] = await tx`SELECT count(DISTINCT si.id)::int AS n FROM sales_invoices si JOIN sales_lines sl ON sl.invoice_id = si.id ${flt}`;
  // margin is a ratio: computed from each row's own profit and recognised revenue (never summed)
  const withMargin = rows.map((r) => ({ ...r, margin: d(r.recognized as string).gt(0) ? d(r.profit as string).div(d(r.recognized as string)).mul(100).toDecimalPlaces(2).toString() : null }));
  const totals = dec(rows as never, ["qty", "gross", "discount", "returns", "net", "recognized", "cost", "profit"]);
  const margin = d(totals.recognized!).gt(0) ? d(totals.profit!).div(totals.recognized!).mul(100).toDecimalPlaces(2).toString() : null;
  return { group: q.group, rows: withMargin, totals: { ...totals, margin, docs: dd!.n }, currency: "IQD" };
}

export async function purchasesReport(tx: Tx, q: ReportQuery) {
  const product = q.group === "product", pf = !!q.productId;       // product grouping/filter: invoice-level charges and returns are not attributable to one product, so only the line's own landed cost is shown
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
           CASE WHEN ${product} THEN NULL WHEN ${pf} THEN sum(landed)::text ELSE COALESCE((SELECT sum(ch.amount_base) FROM purchase_charges ch WHERE ch.purchase_id IN (SELECT doc_id FROM hdr WHERE hdr.key = k.key)), 0)::text END AS charges,
           CASE WHEN ${product} OR ${pf} THEN NULL ELSE COALESCE((SELECT sum(r.total_base) FROM purchase_returns r WHERE r.status = 'POSTED' AND r.purchase_id IN (SELECT doc_id FROM hdr WHERE hdr.key = k.key)), 0)::text END AS returns
    FROM k GROUP BY k.key ORDER BY CASE WHEN ${q.group} IN ('invoice','month') THEN min(doc_date)::text END DESC NULLS LAST, sum(goods) DESC`;
  const t = dec(rows as never, ["qty", "goods", "charges", "returns"]);
  const netOf = (r: Record<string, unknown>) => d(r.goods as string).plus(r.charges ? d(r.charges as string) : 0).minus(r.returns ? d(r.returns as string) : 0).toString();
  const [dd] = await tx`SELECT count(DISTINCT po.id)::int AS n FROM purchase_orders po JOIN purchase_lines pl ON pl.purchase_id = po.id WHERE po.status = 'POSTED' AND NOT po.is_opening
      AND (${q.from ?? null}::date IS NULL OR po.doc_date >= ${q.from ?? null}::date) AND (${q.to ?? null}::date IS NULL OR po.doc_date <= ${q.to ?? null}::date)
      AND (${q.partyId ?? null}::uuid IS NULL OR po.supplier_id = ${q.partyId ?? null}::uuid) AND (${q.productId ?? null}::uuid IS NULL OR pl.product_id = ${q.productId ?? null}::uuid)`;
  return { group: q.group, rows: rows.map((r) => ({ ...r, net: netOf(r) })), totals: { ...t, net: d(t.goods!).plus(t.charges!).minus(t.returns!).toString(), docs: dd!.n }, currency: "IQD" };
}

/** Debtors (customers) / creditors (suppliers): detail = invoice by invoice; summary = one row per party and currency. */
export async function balancesReport(tx: Tx, side: "debtors" | "creditors", q: { partyId?: string; overdueOnly?: boolean; summary?: boolean }) {
  const all = (side === "debtors" ? await receivablesAging(tx) : await payablesAging(tx)) as unknown as Record<string, any>[];
  const nameKey = side === "debtors" ? "customer" : "supplier"; const idKey = side === "debtors" ? "customerId" : "supplierId";
  let rows = all.filter((r) => d(r.outstanding).gt(0));
  if (q.partyId) rows = rows.filter((r) => r[idKey] === q.partyId);
  if (q.overdueOnly) rows = rows.filter((r) => Number(r.daysOverdue) > 0);
  const detail: { docNo: string; party: string; currency: string; total: string | null; paid: string | null; outstanding: string; dueDate: string | null; daysOverdue: number }[] =
    rows.map((r) => ({ docNo: r.docNo, party: r[nameKey], currency: r.currency, total: r.total, paid: d(r.total).minus(r.outstanding).toString(), outstanding: r.outstanding, dueDate: r.dueDate, daysOverdue: Number(r.daysOverdue) }));
  // Payments/receipts that were not allocated to an invoice (customer credit / supplier advance) are real money that reduces what is owed:
  // the party's ledger balance minus the sum of its open invoices is exactly that unallocated amount. Showing it keeps this report equal to the statement.
  if (!q.overdueOnly) {
    const codes = side === "debtors" ? ["1200", "2400"] : ["2100"];
    const led = await tx`SELECT c.id, c.name, COALESCE(jl.currency, 'IQD') AS currency,
        sum(CASE WHEN ${side === "debtors"} THEN (CASE WHEN jl.debit_base > 0 THEN 1 ELSE -1 END) ELSE (CASE WHEN jl.credit_base > 0 THEN 1 ELSE -1 END) END * COALESCE(jl.amount_orig, jl.debit_base + jl.credit_base))::text AS bal
      FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id JOIN contacts c ON c.id = jl.contact_id
      WHERE a.code = ANY(${codes}) AND (${q.partyId ?? null}::uuid IS NULL OR c.id = ${q.partyId ?? null}::uuid) GROUP BY c.id, c.name, COALESCE(jl.currency, 'IQD')`;
    const open = new Map<string, Decimal>(); for (const r of all.filter((x) => d(x.outstanding).gt(0))) { const k = `${r[idKey]}|${r.currency}`; open.set(k, (open.get(k) ?? d(0)).plus(d(r.outstanding))); }
    for (const l of led as unknown as { id: string; name: string; currency: string; bal: string }[]) {
      const diff = d(l.bal).minus(open.get(`${l.id}|${l.currency}`) ?? 0);
      if (diff.abs().gte("0.0001")) detail.push({ docNo: diff.lt(0) ? (side === "debtors" ? "رصيد دائن (دفعة غير مخصصة)" : "سلفة مورد (دفعة غير مخصصة)") : "فرق غير مخصص", party: l.name, currency: l.currency, total: null, paid: null, outstanding: diff.toString(), dueDate: null, daysOverdue: 0 });
    }
  }
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

/** Money a party paid/advanced that is NOT yet tied to an invoice (customer credit / supplier advance), per party+currency. = open invoices − ledger balance. */
export async function unappliedCredits(tx: Tx, side: "debtors" | "creditors") {
  const all = (side === "debtors" ? await receivablesAging(tx) : await payablesAging(tx)) as unknown as Record<string, any>[];
  const idKey = side === "debtors" ? "customerId" : "supplierId";
  const led = await tx`SELECT c.id, COALESCE(jl.currency, 'IQD') AS currency,
      sum(CASE WHEN ${side === "debtors"} THEN (CASE WHEN jl.debit_base > 0 THEN 1 ELSE -1 END) ELSE (CASE WHEN jl.credit_base > 0 THEN 1 ELSE -1 END) END * COALESCE(jl.amount_orig, jl.debit_base + jl.credit_base))::text AS bal
    FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id JOIN contacts c ON c.id = jl.contact_id
    WHERE a.code = ANY(${side === "debtors" ? ["1200", "2400"] : ["2100"]}) GROUP BY c.id, COALESCE(jl.currency, 'IQD')`;
  const open = new Map<string, Decimal>();
  for (const r of all.filter((x) => d(x.outstanding).gt(0))) { const k = `${r[idKey]}|${r.currency}`; open.set(k, (open.get(k) ?? d(0)).plus(d(r.outstanding))); }
  const out = new Map<string, Decimal>();
  for (const l of led as unknown as { id: string; currency: string; bal: string }[]) {
    const k = `${l.id}|${l.currency}`; const credit = (open.get(k) ?? d(0)).minus(d(l.bal)); if (credit.gt(0)) out.set(k, credit);
  }
  return out;
}

/** Oldest-first notional cover of open invoices by the party's unapplied credit: invoiceId → amount of its outstanding that the credit already pays. */
export function coverByCredit(rows: { id: string; partyId: string; currency: string; status: string; outstanding: string | null; date: string }[], credits: Map<string, Decimal>) {
  const left = new Map(credits); const cover = new Map<string, string>();
  for (const r of [...rows].filter((x) => x.status === "POSTED" && x.outstanding && d(x.outstanding).gt(0)).sort((a, b) => a.date.localeCompare(b.date))) {
    const k = `${r.partyId}|${r.currency}`; const avail = left.get(k); if (!avail || avail.lte(0)) continue;
    const take = Decimal.min(avail, d(r.outstanding!)); cover.set(r.id, take.toString()); left.set(k, avail.minus(take));
  }
  return cover;
}

/** One row per customer (and currency): total sales, returns, paid (allocated + unallocated receipts) and what is still owed. */
export async function customersSummary(tx: Tx, partyId?: string) {
  const rows = await tx`
    SELECT c.id AS "partyId", c.name AS party, si.currency, count(*)::int AS invoices, min(si.doc_date)::text AS "firstDate", max(si.doc_date)::text AS "lastDate",
      sum(si.net)::text AS sales,
      COALESCE(sum((SELECT sum(value_orig) FROM sales_returns r WHERE r.invoice_id = si.id AND r.status = 'POSTED')), 0)::text AS returns,
      COALESCE(sum((SELECT sum(a.amount) FROM receipt_allocations a JOIN customer_receipts cr ON cr.id = a.receipt_id WHERE a.invoice_id = si.id AND cr.status = 'POSTED')), 0)::text AS allocated
    FROM sales_invoices si JOIN contacts c ON c.id = si.customer_id WHERE si.status = 'POSTED' AND (${partyId ?? null}::uuid IS NULL OR c.id = ${partyId ?? null}::uuid)
    GROUP BY c.id, c.name, si.currency ORDER BY c.name`;
  const credits = await unappliedCredits(tx, "debtors");
  const open = await receivablesAging(tx) as unknown as Record<string, any>[];
  const owed = new Map<string, Decimal>(); for (const r of open) { const k = `${r.customerId}|${r.currency}`; owed.set(k, (owed.get(k) ?? d(0)).plus(d(r.outstanding))); }
  const out = (rows as unknown as Record<string, any>[]).map((r) => {
    const k = `${r.partyId}|${r.currency}`; const credit = credits.get(k) ?? d(0); const openAmt = owed.get(k) ?? d(0);
    const remaining = Decimal.max(0, openAmt.minus(credit)); const paid = d(r.sales).minus(d(r.returns)).minus(remaining);
    return { partyId: r.partyId as string, party: r.party as string, currency: r.currency as string, invoices: r.invoices as number, invoiceDate: r.firstDate === r.lastDate ? (r.lastDate as string) : `${r.firstDate} ← ${r.lastDate}`, sales: r.sales as string, returns: r.returns as string, paid: paid.toString(), unapplied: credit.toString(), remaining: remaining.toString(), status: remaining.lte(0) ? "PAID" : paid.gt(0) ? "PARTIAL" : "UNPAID" };
  });
  const t = new Map<string, { sales: Decimal; returns: Decimal; paid: Decimal; remaining: Decimal }>();
  for (const r of out) { const e = t.get(r.currency) ?? { sales: d(0), returns: d(0), paid: d(0), remaining: d(0) }; e.sales = e.sales.plus(d(r.sales)); e.returns = e.returns.plus(d(r.returns)); e.paid = e.paid.plus(d(r.paid)); e.remaining = e.remaining.plus(d(r.remaining)); t.set(r.currency, e); }
  return { rows: out, totals: [...t].map(([currency, e]) => ({ currency, sales: e.sales.toString(), returns: e.returns.toString(), paid: e.paid.toString(), remaining: e.remaining.toString() })) };
}

/** Profit that was distributed OUTSIDE the system when an invoice was collected: one row per invoice allocation, with the cash part of the same receipt beside it. */
export async function externalProfitReport(tx: Tx, f: { from?: string; to?: string; partyId?: string } = {}) {
  const rows = await tx`SELECT cr.doc_no AS "receiptNo", cr.doc_date::text AS date, c.name AS customer, si.doc_no AS "invoiceNo", si.net::text AS "invoiceNet",
      COALESCE((SELECT sum(a2.amount) FROM receipt_allocations a2 WHERE a2.receipt_id = cr.id AND a2.invoice_id = si.id AND NOT a2.external), 0)::text AS cash, a.amount::text AS external, a.note
    FROM receipt_allocations a JOIN customer_receipts cr ON cr.id = a.receipt_id JOIN sales_invoices si ON si.id = a.invoice_id JOIN contacts c ON c.id = cr.customer_id
    WHERE a.external AND a.external_kind = 'PROFIT_SHARE' AND cr.status = 'POSTED' AND (${f.from ?? null}::date IS NULL OR cr.doc_date >= ${f.from ?? null}::date) AND (${f.to ?? null}::date IS NULL OR cr.doc_date <= ${f.to ?? null}::date)
      AND (${f.partyId ?? null}::uuid IS NULL OR cr.customer_id = ${f.partyId ?? null}::uuid) ORDER BY cr.doc_date DESC, cr.doc_no DESC`;
  const t = dec(rows as never, ["cash", "external"]); const half = d(t.external!).div(2).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  return { rows, totals: { cash: t.cash, external: t.external, perPartner: half.toString(), count: rows.length } };
}
