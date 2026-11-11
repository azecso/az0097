-- Owner-initiated data reset. Runs as the migration owner (SECURITY DEFINER); the restricted app role
-- has no TRUNCATE/DELETE on the ledger. Wipes every entered record (documents, movements, parties,
-- products, employees, attachments except logo/signature) and restarts numbering. Keeps companies, users and permissions,
-- chart of accounts, cash accounts, expense categories, partners, currencies, fx rates, warehouses,
-- audit log and backup log. Single-company databases only (TRUNCATE is not tenant-scoped).
CREATE FUNCTION reset_company_data(p_company uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM companies) <> 1 OR NOT EXISTS (SELECT 1 FROM companies WHERE id = p_company) THEN
    RAISE EXCEPTION 'reset is only supported for a single-company database';
  END IF;
  TRUNCATE
    accounting_periods, capital_returns, capital_transactions, cash_movements, cash_transfers,
    contacts, customer_receipts, delivery_lines, delivery_notes, employees, expense_payments, expenses,
    inventory_count_lines, inventory_counts, journal_entries, journal_lines, opening_balances,
    payroll_accruals, payroll_payments, personal_advances, personal_debts, product_uoms, products,
    profit_payouts, profit_settlement_lines, profit_settlement_shares, profit_settlements,
    purchase_charges, purchase_lines, purchase_orders, purchase_return_lines, purchase_returns,
    receipt_allocations, sales_invoices, sales_lines, sales_quote_lines, sales_quotes,
    sales_return_lines, sales_returns, stock_lot_consumptions, stock_lot_returns, stock_lots,
    stock_movements, stock_transfer_lines, stock_transfers, supplier_payment_allocations,
    supplier_payments, sync_conflicts, sync_operations;
  -- company logo/signature are settings, not entered records
  DELETE FROM attachments WHERE company_id = p_company AND entity_type NOT IN ('company_logo','company_signature');
  UPDATE document_sequences SET last_number = 0 WHERE company_id = p_company;
END $$;
REVOKE ALL ON FUNCTION reset_company_data(uuid) FROM PUBLIC;
