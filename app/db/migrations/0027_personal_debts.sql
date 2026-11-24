-- Personal debt ("دين شخصي"): money a person (owner, partner or anyone named) took on credit. It is DOCUMENTATION ONLY: it never touches the cash box, the ledger, equity or profit.
-- Repayment is also documentation only (the money is settled outside the box). Nothing is deleted: a debt or a repayment is cancelled with a reason and stays in the history.
ALTER TABLE personal_debts ADD COLUMN doc_no text;
ALTER TABLE personal_debts ADD COLUMN doc_date date NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE personal_debts ADD COLUMN partner_id uuid REFERENCES partners(id);
ALTER TABLE personal_debts ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVERSED'));
ALTER TABLE personal_debts ADD COLUMN reverse_reason text;
CREATE UNIQUE INDEX personal_debts_doc_no_uq ON personal_debts(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE TABLE personal_debt_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  debt_id uuid NOT NULL REFERENCES personal_debts(id),
  pay_date date NOT NULL, amount numeric(20,4) NOT NULL CHECK (amount > 0), note text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVERSED')), reverse_reason text,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON personal_debt_payments(company_id, debt_id);
ALTER TABLE personal_debt_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON personal_debt_payments USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
INSERT INTO document_sequences(company_id, doc_type, fiscal_year, prefix) SELECT id, 'personal_debt', extract(year from now())::int, 'PD' FROM companies ON CONFLICT DO NOTHING;

-- Personal debts: the reset function also clears personal_debt_payments. Same contract as 0016.
CREATE OR REPLACE FUNCTION reset_company_data(p_company uuid, p_user uuid, p_meta jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM companies) <> 1 OR NOT EXISTS (SELECT 1 FROM companies WHERE id = p_company) THEN
    RAISE EXCEPTION 'reset is only supported for a single-company database';
  END IF;
  TRUNCATE
    accounting_periods, capital_returns, capital_transactions, cash_movements, cash_transfers,
    contacts, customer_receipts, customer_refunds, project_entries, projects, delivery_lines, delivery_notes, employees, expense_payments, expenses,
    inventory_count_lines, inventory_counts, journal_entries, journal_lines, opening_balances,
    payroll_accruals, payroll_payments, personal_advances, personal_debts, personal_debt_payments, product_uoms, products,
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
