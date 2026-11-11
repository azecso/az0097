-- The reset function is replaced by a version that also writes the audit entry inside the same transaction.
-- It is NOT executable by the application role (scripts/migrate.ts revokes it); only a dedicated reset role / the DB owner may call it.
DROP FUNCTION reset_company_data(uuid);
CREATE FUNCTION reset_company_data(p_company uuid, p_user uuid, p_meta jsonb) RETURNS void
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
  DELETE FROM attachments WHERE company_id = p_company AND entity_type NOT IN ('company_logo','company_signature');
  UPDATE document_sequences SET last_number = 0 WHERE company_id = p_company;
  INSERT INTO audit_logs(company_id, user_id, action, entity_type, entity_id, after_data, reason)
    VALUES (p_company, p_user, 'DATA_RESET', 'company', p_company, p_meta, 'تصفير البيانات المُدخلة بواسطة المالك');
END $$;
REVOKE ALL ON FUNCTION reset_company_data(uuid, uuid, jsonb) FROM PUBLIC;
