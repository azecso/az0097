-- Round 3: handing REAL cash back to a customer who holds credit (account 2400). A refund is its own operation (not a date change of a receipt): Dr 2400 / Cr cash.
CREATE TABLE customer_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  doc_no text NOT NULL, doc_date date NOT NULL,
  customer_id uuid NOT NULL REFERENCES contacts(id),
  cash_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  currency char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), amount_base numeric(20,4) NOT NULL DEFAULT 0, fx_diff_base numeric(20,4) NOT NULL DEFAULT 0,
  reason text NOT NULL CHECK (length(btrim(reason)) >= 3),
  status text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')),
  journal_entry_id uuid REFERENCES journal_entries(id),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, doc_no)
);
CREATE INDEX ON customer_refunds(company_id, customer_id, doc_date DESC);
ALTER TABLE customer_refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_refunds USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
CREATE TRIGGER customer_refunds_lifecycle BEFORE UPDATE OR DELETE ON customer_refunds FOR EACH ROW EXECUTE FUNCTION guard_document_lifecycle();
INSERT INTO document_sequences(company_id, doc_type, fiscal_year, prefix) SELECT id, 'customer_refund', extract(year from now())::int, 'CF' FROM companies ON CONFLICT DO NOTHING;
