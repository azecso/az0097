-- Manual adjustments that move distributable profit must carry a written reason (enforced in the service and stored here).
ALTER TABLE profit_settlements ADD COLUMN adjustment_reason text;
-- Effective-dated company settings: an append-only history, so a change never silently re-interprets older documents.
CREATE TABLE setting_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  key text NOT NULL, value jsonb NOT NULL, effective_from date NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) >= 3),
  changed_by uuid NOT NULL REFERENCES users(id), changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON setting_changes(company_id, key, effective_from DESC, id DESC);
ALTER TABLE setting_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON setting_changes USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
CREATE TRIGGER setting_changes_append_only BEFORE UPDATE OR DELETE ON setting_changes FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
