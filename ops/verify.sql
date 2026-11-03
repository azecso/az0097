-- Post-restore integrity verification. Every row must say PASS.
\set ON_ERROR_STOP on
SELECT 'journal balanced (sum debit = sum credit)' AS check,
  CASE WHEN (SELECT coalesce(sum(debit_base),0) FROM journal_lines) = (SELECT coalesce(sum(credit_base),0) FROM journal_lines) THEN 'PASS' ELSE 'FAIL' END AS result;
SELECT 'every journal entry balanced' AS check, CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END FROM (SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING sum(debit_base) <> sum(credit_base)) x;
SELECT 'FIFO layers == inventory ledger (1300/1310)' AS check,
  CASE WHEN coalesce((SELECT sum(cost_remaining_base) FROM stock_lots),0) = coalesce((SELECT sum(jl.debit_base-jl.credit_base) FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE a.code IN ('1300','1310')),0) THEN 'PASS' ELSE 'FAIL' END;
SELECT 'no negative stock layers' AS check, CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END FROM stock_lots WHERE qty_remaining < 0 OR cost_remaining_base < 0 OR qty_remaining > qty_received;
SELECT 'no negative cash balance' AS check, CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END FROM
  (SELECT ca.id FROM cash_accounts ca JOIN journal_lines jl ON jl.account_id = ca.account_id GROUP BY ca.id HAVING sum(CASE WHEN jl.debit_base > 0 THEN jl.amount_orig ELSE -jl.amount_orig END) < 0) x;
SELECT 'accounting equation (assets = liabilities + equity + profit)' AS check,
  CASE WHEN (SELECT coalesce(sum(CASE WHEN a.type='ASSET' THEN jl.debit_base-jl.credit_base END),0)
           - coalesce(sum(CASE WHEN a.type='LIABILITY' THEN jl.credit_base-jl.debit_base END),0)
           - coalesce(sum(CASE WHEN a.type='EQUITY' THEN jl.credit_base-jl.debit_base END),0)
           - coalesce(sum(CASE WHEN a.type='REVENUE' THEN jl.credit_base-jl.debit_base END),0)
           + coalesce(sum(CASE WHEN a.type IN ('COGS','EXPENSE') THEN jl.debit_base-jl.credit_base END),0)
           - coalesce(sum(CASE WHEN a.code='7100' THEN jl.credit_base-jl.debit_base END),0)
         FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id) = 0 THEN 'PASS' ELSE 'FAIL' END;
SELECT 'posted documents have numbers' AS check, CASE WHEN (SELECT count(*) FROM sales_invoices WHERE status='POSTED' AND doc_no IS NULL) + (SELECT count(*) FROM purchase_orders WHERE status='POSTED' AND doc_no IS NULL) = 0 THEN 'PASS' ELSE 'FAIL' END;
SELECT 'migrations present' AS check, CASE WHEN (SELECT count(*) FROM schema_migrations) >= 7 THEN 'PASS' ELSE 'FAIL' END;
SELECT 'row counts: journal_entries=' || (SELECT count(*) FROM journal_entries) || ' invoices=' || (SELECT count(*) FROM sales_invoices) || ' purchases=' || (SELECT count(*) FROM purchase_orders) || ' lots=' || (SELECT count(*) FROM stock_lots) AS check, 'INFO' AS result;
