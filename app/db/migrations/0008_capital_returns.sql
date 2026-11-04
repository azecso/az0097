-- Phase 7: capital-return REGISTER. Purely informational: it records what was handed back to the capital owner
-- (when, how much, to whom, which receipt/invoice). It posts NO journal entry and moves NO cash, so unlike accounting
-- documents it may be edited or deleted; every change keeps a full before/after snapshot in the append-only audit log.
CREATE TABLE capital_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  doc_no text NOT NULL, returned_at timestamptz NOT NULL,
  currency char(3) NOT NULL REFERENCES currencies(code),
  amount numeric(20,4) NOT NULL CHECK (amount > 0),
  recipient_name text NOT NULL CHECK (length(btrim(recipient_name)) >= 2),
  ref_no text,                       -- receipt / invoice / voucher number given to the recipient
  method text NOT NULL DEFAULT 'CASH' CHECK (method IN ('CASH','TRANSFER','CHEQUE','OTHER')),
  note text,
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, doc_no)
);
CREATE INDEX ON capital_returns(company_id, returned_at DESC);
ALTER TABLE capital_returns ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON capital_returns USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

INSERT INTO document_sequences(company_id, doc_type, fiscal_year, prefix)
  SELECT id, 'capital_return', extract(year from now())::int, 'CR' FROM companies ON CONFLICT DO NOTHING;
