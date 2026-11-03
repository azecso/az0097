-- Phase 5: offline sync log (idempotency + conflicts) and attachments (logo, signature, product images, receipts).

CREATE TABLE sync_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  operation_id uuid NOT NULL, idempotency_key text NOT NULL, device_id text NOT NULL, user_id uuid NOT NULL REFERENCES users(id),
  entity_type text NOT NULL, entity_local_id uuid NOT NULL,
  op text NOT NULL CHECK (op IN ('CREATE_DRAFT','UPDATE_DRAFT','SUBMIT_FOR_POSTING')),
  base_version int, payload jsonb NOT NULL,
  client_created_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','ACCEPTED','REJECTED','CONFLICT')),
  result_code text, result jsonb, server_entity_id uuid,
  UNIQUE (company_id, operation_id), UNIQUE (company_id, idempotency_key)
);
CREATE INDEX ON sync_operations(company_id, entity_local_id, op);
CREATE TABLE sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  operation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('VERSION_MISMATCH','INSUFFICIENT_STOCK','INSUFFICIENT_CASH','CREDIT_LIMIT','PERIOD_CLOSED','PERMISSION_CHANGED','OTHER')),
  detail text, server_snapshot jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, operation_id) REFERENCES sync_operations(company_id, operation_id)
);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  entity_type text NOT NULL, entity_id uuid NOT NULL,
  storage_name text NOT NULL, original_name text NOT NULL, sha256 char(64) NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes int NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  uploaded_by uuid NOT NULL REFERENCES users(id), uploaded_at timestamptz NOT NULL DEFAULT now(),
  is_deleted boolean NOT NULL DEFAULT false
);
CREATE INDEX ON attachments(company_id, entity_type, entity_id);
CREATE TRIGGER sync_operations_no_delete BEFORE DELETE ON sync_operations FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sync_operations','sync_conflicts','attachments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$f$, t);
  END LOOP;
END $$;
