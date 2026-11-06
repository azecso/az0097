import type { Tx } from "../db";
import { notFound } from "../errors";

/** Read models for the printable documents that have no dedicated screen-detail API (returns, expenses, stock transfers, capital, settlements). */
export const PRINT_KINDS = ["sales-return", "purchase-return", "expense", "stock-transfer", "capital", "settlement", "profit-payout"] as const;
export type PrintKind = (typeof PRINT_KINDS)[number];
export const PRINT_PERM: Record<PrintKind, string> = { "sales-return": "sales", "purchase-return": "purchase", expense: "expense", "stock-transfer": "stock_transfer", capital: "capital", settlement: "profit_settlement", "profit-payout": "profit_payout" };

export async function getPrintDoc(tx: Tx, kind: PrintKind, id: string): Promise<Record<string, any>> {
  if (kind === "sales-return") {
    const [h] = await tx`SELECT r.doc_no AS "docNo", r.draft_ref AS "draftRef", r.doc_date::text AS "docDate", r.reason, r.settlement, r.status, r.value_orig::text AS value, r.applied_orig::text AS applied, r.credit_orig::text AS credit, r.refund_orig::text AS refund,
        si.doc_no AS "invoiceNo", si.currency, c.name AS party, c.phones, c.address FROM sales_returns r JOIN sales_invoices si ON si.id = r.invoice_id JOIN contacts c ON c.id = si.customer_id WHERE r.id = ${id}`;
    if (!h) throw notFound();
    const lines = await tx`SELECT p.code, p.name, sl.uom, rl.qty_base::text AS qty, rl.value_orig::text AS value FROM sales_return_lines rl JOIN sales_lines sl ON sl.id = rl.sales_line_id JOIN products p ON p.id = sl.product_id WHERE rl.return_id = ${id} ORDER BY rl.line_no`;
    return { ...h, lines };
  }
  if (kind === "purchase-return") {
    const [h] = await tx`SELECT r.doc_no AS "docNo", r.draft_ref AS "draftRef", r.doc_date::text AS "docDate", r.reason, r.settlement, r.status, r.total_orig::text AS total, po.doc_no AS "purchaseNo", po.currency, c.name AS party, c.phones, c.address
        FROM purchase_returns r JOIN purchase_orders po ON po.id = r.purchase_id JOIN contacts c ON c.id = po.supplier_id WHERE r.id = ${id}`;
    if (!h) throw notFound();
    const lines = await tx`SELECT p.code, p.name, pl.uom, rl.qty_base::text AS qty, rl.shortage_qty_base::text AS shortage, rl.exceptional_reason AS "exceptionalReason" FROM purchase_return_lines rl JOIN purchase_lines pl ON pl.id = rl.purchase_line_id JOIN products p ON p.id = pl.product_id WHERE rl.return_id = ${id} ORDER BY rl.line_no`;
    return { ...h, lines };
  }
  if (kind === "expense") {
    const [h] = await tx`SELECT e.doc_no AS "docNo", e.draft_ref AS "draftRef", e.doc_date::text AS "docDate", ec.name AS category, e.description, e.currency, e.exchange_rate_snapshot::text AS "exchangeRate", e.amount::text AS amount, e.payment_mode AS "paymentMode",
        ca.name AS "cashAccount", e.partner_treatment AS "partnerTreatment", e.settlement_note AS "settlementNote", e.status FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id LEFT JOIN cash_accounts ca ON ca.id = e.cash_account_id WHERE e.id = ${id}`;
    if (!h) throw notFound(); return h;
  }
  if (kind === "stock-transfer") {
    const [h] = await tx`SELECT t.doc_no AS "docNo", t.draft_ref AS "draftRef", t.doc_date::text AS "docDate", f.name AS "from", o.name AS "to", t.notes, t.status
        FROM stock_transfers t JOIN stock_locations f ON f.id = t.from_location_id JOIN stock_locations o ON o.id = t.to_location_id WHERE t.id = ${id}`;
    if (!h) throw notFound();
    const lines = await tx`SELECT p.code, p.name, l.uom, l.qty::text AS qty FROM stock_transfer_lines l JOIN products p ON p.id = l.product_id WHERE l.transfer_id = ${id} ORDER BY l.line_no`;
    return { ...h, lines };
  }
  if (kind === "capital") {
    const [h] = await tx`SELECT t.doc_no AS "docNo", t.draft_ref AS "draftRef", t.doc_date::text AS "docDate", t.kind, t.currency, t.amount::text AS amount, t.reason, t.status, pa.name AS partner, ca.name AS "cashAccount",
        ru.display_name AS "requestedBy", au.display_name AS "approvedBy", t.rejected_reason AS "rejectedReason"
        FROM capital_transactions t JOIN partners pa ON pa.id = t.partner_id JOIN cash_accounts ca ON ca.id = t.cash_account_id JOIN users ru ON ru.id = t.requested_by LEFT JOIN users au ON au.id = t.approved_by WHERE t.id = ${id}`;
    if (!h) throw notFound(); return h;
  }
  if (kind === "profit-payout") {
    const [h] = await tx`SELECT po.doc_no AS "docNo", po.doc_date::text AS "docDate", pa.name AS partner, pa.kind AS "partnerKind", po.amount::text AS amount, po.advances_deducted::text AS advances, ca.name AS "cashAccount", s.doc_no AS "settlementNo", po.status, u.display_name AS "paidBy"
      FROM profit_payouts po JOIN partners pa ON pa.id = po.partner_id JOIN profit_settlements s ON s.id = po.settlement_id LEFT JOIN cash_accounts ca ON ca.id = po.cash_account_id LEFT JOIN users u ON u.id = po.paid_by WHERE po.id = ${id}`;
    if (!h) throw notFound(); return h;
  }
  const [h] = await tx`SELECT s.doc_no AS "docNo", s.draft_ref AS "draftRef", s.period_start::text AS "periodStart", s.period_end::text AS "periodEnd", s.eligible_profit::text AS eligible, s.deductions::text AS deductions, s.adjustments::text AS adjustments,
      s.loss_carried_in::text AS "lossIn", s.reserved::text AS reserved, s.loss_covered::text AS "lossCovered", s.loss_carried_out::text AS "lossOut", s.distributable::text AS distributable, s.status, s.notes, au.display_name AS "approvedBy"
      FROM profit_settlements s LEFT JOIN users au ON au.id = s.approved_by WHERE s.id = ${id}`;
  if (!h) throw notFound(); return h;
}
