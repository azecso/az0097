import type { Tx } from "../db";
import { notFound } from "../errors";
import { d } from "../money";

export const stockSummary = (tx: Tx) => tx`
  SELECT p.id AS "productId", p.code, p.name, p.base_uom AS "baseUom", sl.id AS "locationId", sl.name AS location, w.kind AS "warehouseKind",
         sum(l.qty_remaining)::text AS qty, sum(l.cost_remaining_base)::text AS value
  FROM stock_lots l JOIN products p ON p.id = l.product_id JOIN stock_locations sl ON sl.id = l.location_id JOIN warehouses w ON w.id = sl.warehouse_id
  WHERE l.qty_remaining > 0 GROUP BY p.id, p.code, p.name, p.base_uom, sl.id, sl.name, w.kind ORDER BY p.code, sl.name`;

export const lotsOf = (tx: Tx, productId: string) => tx`
  SELECT l.id, sl.name AS location, l.received_at AS "receivedAt", l.qty_received::text AS "qtyReceived", l.qty_remaining::text AS "qtyRemaining",
         l.unit_cost_base::text AS "unitCostBase", l.cost_remaining_base::text AS "costRemaining", l.currency, l.fx_rate_snapshot::text AS fx,
         l.origin_doc_type AS "originType", l.source_lot_id AS "sourceLotId"
  FROM stock_lots l JOIN stock_locations sl ON sl.id = l.location_id WHERE l.product_id = ${productId} ORDER BY l.received_at, l.seq`;

export async function trialBalance(tx: Tx) {
  const rows = await tx`SELECT a.code, a.name, a.type, COALESCE(sum(jl.debit_base), 0)::text AS debit, COALESCE(sum(jl.credit_base), 0)::text AS credit
    FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id = a.id GROUP BY a.code, a.name, a.type ORDER BY a.code`;
  const td = rows.reduce((s, r) => s.plus(r.debit), d(0)), tc = rows.reduce((s, r) => s.plus(r.credit), d(0));
  return { rows: rows.filter((r) => !d(r.debit).isZero() || !d(r.credit).isZero()), totalDebit: td.toString(), totalCredit: tc.toString(), balanced: td.eq(tc) };
}

/** Sub-ledger vs general ledger: FIFO layers must equal accounts 1300/1310 to the dinar, always. */
export async function inventoryReconciliation(tx: Tx) {
  const lots = await tx`SELECT w.kind, COALESCE(sum(l.cost_remaining_base), 0)::text AS v FROM stock_locations sl JOIN warehouses w ON w.id = sl.warehouse_id
      LEFT JOIN stock_lots l ON l.location_id = sl.id GROUP BY w.kind`;
  const gl = await tx`SELECT a.code, COALESCE(sum(jl.debit_base - jl.credit_base), 0)::text AS v FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id = a.id WHERE a.code IN ('1300','1310') GROUP BY a.code`;
  const lv = (k: string) => d(lots.find((r) => r.kind === k)?.v ?? 0), gv = (c: string) => d(gl.find((r) => r.code === c)?.v ?? 0);
  const main = { lots: lv("MAIN").toString(), ledger: gv("1300").toString(), diff: lv("MAIN").minus(gv("1300")).toString() };
  const partner = { lots: lv("PARTNER_CUSTODY").toString(), ledger: gv("1310").toString(), diff: lv("PARTNER_CUSTODY").minus(gv("1310")).toString() };
  return { main, partner, ok: d(main.diff).isZero() && d(partner.diff).isZero() };
}

export async function supplierStatement(tx: Tx, supplierId: string) {
  const [s] = await tx`SELECT id, code, name FROM contacts WHERE id = ${supplierId}`;
  if (!s) throw notFound();
  const lines = await tx`SELECT je.entry_date::text AS date, je.entry_no AS "entryNo", je.source_doc_type AS "docType", je.memo, jl.currency, jl.amount_orig::text AS "amountOrig",
      jl.debit_base::text AS debit, jl.credit_base::text AS credit FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
    WHERE jl.contact_id = ${supplierId} AND a.code = '2100' ORDER BY je.entry_date, je.posted_at, jl.line_no`;
  let bal = d(0);
  const out = lines.map((l) => { bal = bal.plus(l.credit).minus(l.debit); return { ...l, balance: bal.toString() }; });   // + = we owe the supplier
  return { supplier: s, lines: out, balance: bal.toString() };
}

export const payablesAging = (tx: Tx) => tx`
  SELECT po.id, po.doc_no AS "docNo", c.name AS supplier, po.currency, po.total::text AS total, po.due_date::text AS "dueDate",
         GREATEST(0, CURRENT_DATE - po.due_date) AS "daysOverdue",
         (po.total - COALESCE((SELECT sum(a.amount) FROM supplier_payment_allocations a JOIN supplier_payments sp ON sp.id = a.payment_id WHERE a.purchase_id = po.id AND sp.status = 'POSTED'), 0)
                   - COALESCE((SELECT sum(r.total_orig) FROM purchase_returns r WHERE r.purchase_id = po.id AND r.status = 'POSTED' AND r.settlement = 'REDUCE_PAYABLE'), 0))::text AS outstanding
  FROM purchase_orders po JOIN contacts c ON c.id = po.supplier_id WHERE po.status = 'POSTED' AND po.payment_type = 'CREDIT'
  ORDER BY po.due_date NULLS LAST`;

export const cashAccounts = (tx: Tx) => tx`
  SELECT ca.id, ca.name, ca.currency, ca.kind, ca.counts_toward_available_cash AS "countsTowardAvailable", COALESCE(sum(cm.amount), 0)::text AS balance
  FROM cash_accounts ca LEFT JOIN cash_movements cm ON cm.cash_account_id = ca.id WHERE ca.is_active GROUP BY ca.id ORDER BY ca.kind, ca.currency`;

export const locations = (tx: Tx) => tx`SELECT sl.id, sl.name, w.kind FROM stock_locations sl JOIN warehouses w ON w.id = sl.warehouse_id ORDER BY w.kind`;

export const journalList = (tx: Tx, limit = 100) => tx`
  SELECT je.id, je.entry_no AS "entryNo", je.entry_date::text AS date, je.source_doc_type AS "docType", je.memo, je.reverses_entry_id AS "reverses",
    (SELECT json_agg(json_build_object('account', a.code, 'name', a.name, 'debit', jl.debit_base::text, 'credit', jl.credit_base::text) ORDER BY jl.line_no)
     FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.entry_id = je.id) AS lines
  FROM journal_entries je ORDER BY je.posted_at DESC, je.entry_no DESC LIMIT ${limit}`;
