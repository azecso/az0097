-- (1) A receipt may settle invoices of ANOTHER currency through an explicit, visible conversion rate (dinars per 1 USD); the rate is stored on the receipt.
ALTER TABLE customer_receipts ADD COLUMN settlement_rate numeric(18,8) CHECK (settlement_rate IS NULL OR settlement_rate > 0);
-- (2) Idempotency: one row per (company, key). A retried / double-clicked request returns the stored response instead of posting a second document.
CREATE TABLE request_keys (
  company_id uuid NOT NULL REFERENCES companies(id),
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 120),
  action text NOT NULL, response jsonb, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);
ALTER TABLE request_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON request_keys USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
CREATE TRIGGER request_keys_no_delete BEFORE DELETE ON request_keys FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
