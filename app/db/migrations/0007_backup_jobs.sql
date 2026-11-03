-- Phase 6: backup / restore-drill bookkeeping (written by ops/backup.sh and ops/restore-test.sh, read by the owner integrity screen).
CREATE TABLE backup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  kind text NOT NULL CHECK (kind IN ('DAILY','WEEKLY','MONTHLY','RESTORE_TEST')),
  started_at timestamptz NOT NULL, finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('RUNNING','OK','FAILED')),
  size_bytes bigint, sha256 char(64), remote_location text, error text, verification jsonb
);
CREATE INDEX ON backup_jobs(company_id, kind, started_at DESC);
ALTER TABLE backup_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON backup_jobs USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
CREATE TRIGGER backup_jobs_no_delete BEFORE DELETE ON backup_jobs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
