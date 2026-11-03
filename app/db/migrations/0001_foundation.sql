-- Phase 1 foundation: company, users, sessions, permissions, currencies, FX, chart of accounts,
-- numbering, audit log, RLS. Money NUMERIC only. No ON DELETE CASCADE.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_TABLE % (% not allowed)', TG_TABLE_NAME, TG_OP; END $$;

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, name_en text,
  logo_attachment_id uuid, signature_attachment_id uuid,
  address text, phones text[],
  base_currency char(3) NOT NULL DEFAULT 'IQD',
  allow_negative_stock boolean NOT NULL DEFAULT false,
  landed_cost_policy text NOT NULL DEFAULT 'EXCLUDE' CHECK (landed_cost_policy IN ('EXCLUDE','INCLUDE')),
  loss_policy text NOT NULL DEFAULT 'CARRY_FORWARD' CHECK (loss_policy = 'CARRY_FORWARD'),
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  username text NOT NULL CHECK (username = lower(username) AND length(username) BETWEEN 3 AND 64),
  display_name text NOT NULL,
  password_hash text NOT NULL,
  is_owner boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOCKED','DISABLED')),
  failed_logins int NOT NULL DEFAULT 0, locked_until timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  UNIQUE (company_id, username)
);
CREATE UNIQUE INDEX one_owner_per_company ON users(company_id) WHERE is_owner;
CREATE UNIQUE INDEX users_username_global ON users(username);   -- single-business system: login by username

CREATE TABLE sessions (
  id_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  company_id uuid NOT NULL REFERENCES companies(id),
  csrf_token text NOT NULL, device_id text, ip inet, user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX ON sessions(user_id);

CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource text NOT NULL,
  action text NOT NULL CHECK (action IN ('view','create','edit_draft','approve','cancel','print','export')),
  owner_only boolean NOT NULL DEFAULT false,
  UNIQUE (resource, action)
);

CREATE TABLE user_permissions (
  user_id uuid NOT NULL REFERENCES users(id),
  permission_id uuid NOT NULL REFERENCES permissions(id),
  granted_by uuid NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_id),
  CHECK (granted_by <> user_id)
);

-- Defense in depth: owner-only permissions can never be held by a non-owner, and only the owner can grant.
CREATE FUNCTION assert_grant_rules() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.granted_by AND is_owner) THEN
    RAISE EXCEPTION 'ONLY_OWNER_CAN_GRANT';
  END IF;
  IF EXISTS (SELECT 1 FROM permissions WHERE id = NEW.permission_id AND owner_only)
     AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND is_owner) THEN
    RAISE EXCEPTION 'OWNER_ONLY_PERMISSION';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER user_permissions_rules BEFORE INSERT OR UPDATE ON user_permissions
  FOR EACH ROW EXECUTE FUNCTION assert_grant_rules();

CREATE TABLE currencies (
  code char(3) PRIMARY KEY, name text NOT NULL,
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 4)
);
INSERT INTO currencies VALUES ('IQD','دينار عراقي',0),('USD','دولار أمريكي',2);

CREATE TABLE fx_rates (                -- manual daily rate: IQD per 1 USD
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  currency char(3) NOT NULL REFERENCES currencies(code),
  rate_date date NOT NULL, rate numeric(18,8) NOT NULL CHECK (rate > 0),
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id), updated_at timestamptz,
  UNIQUE (company_id, currency, rate_date)
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  code text NOT NULL, name text NOT NULL,
  type text NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','COGS','EXPENSE','OTHER')),
  normal_side text NOT NULL CHECK (normal_side IN ('DEBIT','CREDIT')),
  is_postable boolean NOT NULL DEFAULT true, is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, code)
);

CREATE TABLE document_sequences (
  company_id uuid NOT NULL REFERENCES companies(id),
  doc_type text NOT NULL, fiscal_year int NOT NULL,
  prefix text NOT NULL, last_number bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, doc_type, fiscal_year)
);

-- Gapless numbering: row lock held until COMMIT; ROLLBACK consumes no number.
CREATE FUNCTION next_document_number(p_company uuid, p_type text, p_year int) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE r document_sequences;
BEGIN
  UPDATE document_sequences SET last_number = last_number + 1
   WHERE company_id = p_company AND doc_type = p_type AND fiscal_year = p_year
   RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'SEQUENCE_NOT_CONFIGURED %', p_type; END IF;
  RETURN r.prefix || '-' || p_year || '-' || lpad(r.last_number::text, 6, '0');
END $$;

CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid REFERENCES users(id), device_id text, ip inet,
  action text NOT NULL, entity_type text NOT NULL, entity_id uuid,
  before_data jsonb, after_data jsonb, reason text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_logs(company_id, entity_type, entity_id, occurred_at);
CREATE INDEX ON audit_logs(company_id, occurred_at DESC);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------- Permission catalog ----------
INSERT INTO permissions(resource, action, owner_only)
SELECT r.resource, a.action,
  CASE
    WHEN r.resource IN ('users','backup') THEN true
    WHEN r.resource = 'company' AND a.action IN ('create','edit_draft') THEN true
    WHEN r.resource IN ('capital','capital_withdrawal','personal','opening_balance','profit_settlement',
                        'profit_payout','period_close','inventory_count') AND a.action IN ('approve','cancel') THEN true
    ELSE false END
FROM (VALUES ('company'),('users'),('contacts'),('products'),('fx_rate'),('purchase'),('sales'),('voucher'),
             ('stock_transfer'),('inventory_count'),('expense'),('payroll'),('capital'),('capital_withdrawal'),
             ('personal'),('opening_balance'),('profit_settlement'),('profit_payout'),('period_close'),
             ('journal'),('audit'),('backup'),('report')) AS r(resource)
CROSS JOIN (VALUES ('view'),('create'),('edit_draft'),('approve'),('cancel'),('print'),('export')) AS a(action);

-- ---------- Secure auth lookups (login happens before a tenant is known) ----------
CREATE FUNCTION auth_find_user(p_username text) RETURNS SETOF users
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT * FROM users WHERE username = lower(p_username) $$;

CREATE FUNCTION auth_record_failure(p_user uuid, p_max int, p_lock_minutes int) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE users SET failed_logins = failed_logins + 1,
    locked_until = CASE WHEN failed_logins + 1 >= p_max THEN now() + make_interval(mins => p_lock_minutes) ELSE locked_until END
  WHERE id = p_user $$;

CREATE FUNCTION auth_record_success(p_user uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = p_user $$;

CREATE FUNCTION auth_create_session(p_hash bytea, p_user uuid, p_csrf text, p_device text, p_ip inet, p_ua text, p_hours int)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO sessions(id_hash,user_id,company_id,csrf_token,device_id,ip,user_agent,expires_at)
  SELECT p_hash, u.id, u.company_id, p_csrf, p_device, p_ip, p_ua, now() + make_interval(hours => p_hours)
  FROM users u WHERE u.id = p_user $$;

CREATE FUNCTION auth_find_session(p_hash bytea, p_idle_minutes int)
RETURNS TABLE(user_id uuid, company_id uuid, csrf_token text, username text, display_name text, is_owner boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT s.user_id, s.company_id, s.csrf_token, u.username, u.display_name, u.is_owner
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.id_hash = p_hash AND s.revoked_at IS NULL AND s.expires_at > now()
    AND s.last_seen_at > now() - make_interval(mins => p_idle_minutes) AND u.status = 'ACTIVE' $$;

CREATE FUNCTION auth_touch_session(p_hash bytea) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ UPDATE sessions SET last_seen_at = now() WHERE id_hash = p_hash $$;

CREATE FUNCTION auth_revoke_session(p_hash bytea) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ UPDATE sessions SET revoked_at = now() WHERE id_hash = p_hash $$;

CREATE FUNCTION auth_revoke_user_sessions(p_user uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ UPDATE sessions SET revoked_at = now() WHERE user_id = p_user AND revoked_at IS NULL $$;

-- ---------- Row-Level Security: tenant isolation ----------
-- NOT forced: the migration/owner role (and SECURITY DEFINER auth functions) bypass it; the application
-- connects as a separate NON-owner role (see scripts/migrate.ts) so RLS always applies to it.
-- Tables WITH company_id are forced to match app.company_id. `users` and `sessions` are reached by the
-- app only through tenant-scoped queries (after login) or the SECURITY DEFINER functions above.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','sessions','fx_rates','accounts','document_sequences','audit_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$f$, t);
  END LOOP;
  ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON companies
    USING (id = nullif(current_setting('app.company_id', true), '')::uuid)
    WITH CHECK (id = nullif(current_setting('app.company_id', true), '')::uuid);
END $$;
