-- Projects: money spent on a project leaves the cash box immediately and is accumulated per project; money that comes back reduces the project's cost and returns to the box.
-- Booked as Dr 1700 (project costs — an asset account, NOT a 6xxx expense) / Cr cash, so it never enters or reduces the partners' distributable profit; the project report shows the net cost.
INSERT INTO accounts(company_id, code, name, type, normal_side, is_system)
  SELECT id, '1700', 'تكاليف المشاريع (خارج أرباح الشراكة)', 'ASSET', 'DEBIT', true FROM companies ON CONFLICT (company_id, code) DO NOTHING;
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL CHECK (length(btrim(name)) >= 2), notes text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_name_uq ON projects(company_id, lower(btrim(name)));
CREATE TABLE project_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  doc_no text NOT NULL, doc_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('SPEND','REFUND')),
  cash_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  currency char(3) NOT NULL REFERENCES currencies(code), exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), amount_base numeric(20,4) NOT NULL DEFAULT 0,
  note text,
  status text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')),
  journal_entry_id uuid REFERENCES journal_entries(id),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, doc_no)
);
CREATE INDEX ON project_entries(company_id, project_id, doc_date DESC);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['projects','project_entries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid) WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$f$, t);
  END LOOP;
END $$;
CREATE TRIGGER project_entries_lifecycle BEFORE UPDATE OR DELETE ON project_entries FOR EACH ROW EXECUTE FUNCTION guard_document_lifecycle();
INSERT INTO document_sequences(company_id, doc_type, fiscal_year, prefix) SELECT id, 'project_entry', extract(year from now())::int, 'PJ' FROM companies ON CONFLICT DO NOTHING;

-- Projects: the reset function also clears project_entries and projects. Same contract as 0016.
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
