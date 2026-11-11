-- READ-ONLY impact report for an existing database before/after applying migrations 0013-0018 and the fixes of this branch.
-- Run:  psql "$DATABASE_URL" -f ops/data-impact.sql      (as the DB owner or a read-only role). Nothing here writes.
-- Each section says what it finds and what the correction plan is (docs/DATA_IMPACT.md). History is never rewritten: corrections are NEW dated entries.

\echo '1) USD cash openings booked with a 1:1 rate (100 USD = 100 IQD). Plan: owner posts a correcting entry dated the opening date or the next open day.'
SELECT je.entry_no, je.entry_date, a.code, jl.currency, jl.amount_orig, jl.fx_rate_snapshot, jl.debit_base AS booked_iqd, round(jl.amount_orig * (SELECT rate FROM fx_rates WHERE currency = 'USD' AND rate_date <= je.entry_date ORDER BY rate_date DESC LIMIT 1)) AS suggested_iqd
FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
WHERE je.source_doc_type = 'opening' AND jl.currency = 'USD' AND jl.fx_rate_snapshot = 1 AND jl.debit_base > 0;

\echo '2) Foreign-currency expense / salary payments booked at the accrual rate on both sides (payments made before migration 0014 have no payment rate). Plan: review only; FX difference was not recognised.'
SELECT 'expense_payment' AS kind, p.doc_no, p.doc_date, e.currency, p.amount, e.exchange_rate_snapshot AS booked_rate
FROM expense_payments p JOIN expenses e ON e.id = p.expense_id WHERE e.currency <> 'IQD' AND p.exchange_rate_snapshot IS NULL AND p.status = 'POSTED'
UNION ALL
SELECT 'payroll_payment', p.doc_no, p.doc_date, a.currency, p.amount, a.exchange_rate_snapshot
FROM payroll_payments p JOIN payroll_accruals a ON a.id = p.accrual_id WHERE a.currency <> 'IQD' AND p.exchange_rate_snapshot IS NULL AND p.status = 'POSTED';

\echo '3) Customer credit (2400) applied across currencies: receipts of kind CREDIT_APPLICATION whose credit was created in another currency. Plan: owner reviews each; correct by reversing and re-applying in the right currency.'
SELECT r.doc_no, r.doc_date, r.currency AS applied_in, c.name AS customer,
       (SELECT string_agg(DISTINCT jl.currency, ',') FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '2400' AND jl.contact_id = r.customer_id AND jl.credit_base > 0) AS credit_currencies
FROM customer_receipts r JOIN contacts c ON c.id = r.customer_id WHERE r.kind = 'CREDIT_APPLICATION' AND r.status = 'POSTED'
  AND EXISTS (SELECT 1 FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code = '2400' AND jl.contact_id = r.customer_id AND jl.credit_base > 0 AND jl.currency <> r.currency);

\echo '4) Invoices with separate delivery whose revenue was recognised at invoicing and are still (partly) undelivered. Plan: after owner approval, a dated reclassification Dr 4100 / Cr 2600 for the undelivered value; profit eligibility is already computed from delivered quantities.'
SELECT si.doc_no, si.doc_date, c.name AS customer, si.currency, si.net,
       (SELECT sum(sl.qty_base) FROM sales_lines sl WHERE sl.invoice_id = si.id) AS qty_invoiced,
       (SELECT COALESCE(sum(dl.qty_base), 0) FROM delivery_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_id JOIN sales_lines sl ON sl.id = dl.sales_line_id WHERE sl.invoice_id = si.id AND dn.status = 'POSTED') AS qty_delivered
FROM sales_invoices si JOIN contacts c ON c.id = si.customer_id
WHERE si.status = 'POSTED' AND si.delivery_mode = 'SEPARATE' AND NOT si.revenue_deferred AND NOT si.is_opening
  AND (SELECT sum(sl.qty_base) FROM sales_lines sl WHERE sl.invoice_id = si.id) > (SELECT COALESCE(sum(dl.qty_base), 0) FROM delivery_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_id JOIN sales_lines sl ON sl.id = dl.sales_line_id WHERE sl.invoice_id = si.id AND dn.status = 'POSTED');

\echo '5) Profit already released by APPROVED settlements on invoices that had undelivered goods or later-dated documents at the time (possible over-release). Plan: the next settlement shows a negative eligible amount automatically (clawback, no retro edit).'
SELECT s.doc_no AS settlement, s.period_end, i.doc_no AS invoice, l.newly_released,
       (SELECT COALESCE(sum(dl.qty_base), 0) FROM delivery_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_id JOIN sales_lines sl ON sl.id = dl.sales_line_id WHERE sl.invoice_id = i.id AND dn.status = 'POSTED' AND dn.doc_date <= s.period_end) AS delivered_by_period_end,
       (SELECT sum(sl.qty_base) FROM sales_lines sl WHERE sl.invoice_id = i.id) AS invoiced
FROM profit_settlement_lines l JOIN profit_settlements s ON s.id = l.settlement_id JOIN sales_invoices i ON i.id = l.invoice_id WHERE s.status = 'POSTED'
  AND (SELECT COALESCE(sum(dl.qty_base), 0) FROM delivery_lines dl JOIN delivery_notes dn ON dn.id = dl.delivery_id JOIN sales_lines sl ON sl.id = dl.sales_line_id WHERE sl.invoice_id = i.id AND dn.status = 'POSTED' AND dn.doc_date <= s.period_end)
      < (SELECT sum(sl.qty_base) FROM sales_lines sl WHERE sl.invoice_id = i.id);

\echo '6) Reserve held back in approved settlements before reserve tracking existed (reserved > 0). The amount was never distributed; from now on it is a visible balance that can be released with a reason.'
SELECT doc_no, period_end, reserved, reserve_released FROM profit_settlements WHERE status = 'POSTED' AND reserved > 0 ORDER BY period_end;

\echo '7) Months closed with a snapshot that included later movements (old snapshots had no as-of date). Plan: informational; re-close after re-opening if the snapshot is relied upon.'
SELECT period_month, closed_at, (snapshot->>'asOf') IS NULL AS legacy_snapshot FROM accounting_periods WHERE status = 'CLOSED' AND (snapshot->>'asOf') IS NULL ORDER BY period_month;

\echo '8) (round 2) Invoices whose profit was released by an approved settlement but that are NOT fully paid today. Under the "paid AND delivered in full" rule their eligible profit is now 0, so the NEXT settlement will show a negative (clawback) line for them. Review the preview before approving.'
SELECT s.doc_no AS settlement, i.doc_no AS invoice, l.newly_released,
       i.net - COALESCE((SELECT sum(a.amount) FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id WHERE a.invoice_id = i.id AND r.status = 'POSTED'), 0)
             - COALESCE((SELECT sum(applied_orig) FROM sales_returns WHERE invoice_id = i.id AND status = 'POSTED'), 0) AS still_owed
FROM profit_settlement_lines l JOIN profit_settlements s ON s.id = l.settlement_id JOIN sales_invoices i ON i.id = l.invoice_id
WHERE s.status = 'POSTED' AND l.released_after > 0
  AND i.net - COALESCE((SELECT sum(a.amount) FROM receipt_allocations a JOIN customer_receipts r ON r.id = a.receipt_id WHERE a.invoice_id = i.id AND r.status = 'POSTED'), 0)
           - COALESCE((SELECT sum(applied_orig) FROM sales_returns WHERE invoice_id = i.id AND status = 'POSTED'), 0) > 0;
