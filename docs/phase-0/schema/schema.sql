-- ============================================================================
-- Phase 0 — DESIGN DRAFT of the PostgreSQL schema (NOT production migrations).
-- Purpose: prove the data model + accounting invariants on real PostgreSQL 16.
-- Final migrations are written in Phase 1 after approval.
-- Money NUMERIC(20,4) | Quantity NUMERIC(20,6) | FX rate NUMERIC(18,8). Never float.
-- No ON DELETE CASCADE on financial tables (RESTRICT / default NO ACTION only).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- needed for the settlement-overlap EXCLUDE constraint

-- ------------------------------ 1. Core -------------------------------------
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
  username text NOT NULL, display_name text NOT NULL,
  password_hash text NOT NULL,                       -- Argon2id
  totp_secret_enc bytea,                             -- encrypted at rest
  is_owner boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','LOCKED','DISABLED')),
  failed_logins int NOT NULL DEFAULT 0, locked_until timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  UNIQUE (company_id, username)
);
-- exactly one owner per company
CREATE UNIQUE INDEX one_owner_per_company ON users(company_id) WHERE is_owner;

CREATE TABLE sessions (
  id_hash bytea PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  company_id uuid NOT NULL REFERENCES companies(id),
  device_id text, ip inet, user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, revoked_at timestamptz
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  code text NOT NULL, name text NOT NULL,
  UNIQUE (company_id, code)
);

-- Catalog of fine-grained permissions, e.g. ('sales_invoice','approve').
CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource text NOT NULL,
  action text NOT NULL CHECK (action IN ('view','create','edit_draft','approve','cancel','print','export')),
  owner_only boolean NOT NULL DEFAULT false,        -- e.g. capital withdraw approval: never grantable to accountant
  UNIQUE (resource, action)
);

CREATE TABLE user_permissions (
  user_id uuid NOT NULL REFERENCES users(id),
  permission_id uuid NOT NULL REFERENCES permissions(id),
  granted_by uuid NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_id),
  CHECK (granted_by <> user_id)                     -- nobody self-grants
);

CREATE TABLE currencies (
  code char(3) PRIMARY KEY, name text NOT NULL,
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 4)   -- IQD 0, USD 2
);

CREATE TABLE fx_rates (                              -- manual daily rate, IQD per 1 USD
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  currency char(3) NOT NULL REFERENCES currencies(code),
  rate_date date NOT NULL, rate numeric(18,8) NOT NULL CHECK (rate > 0),
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, currency, rate_date)
);

CREATE TABLE accounts (                              -- chart of accounts
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  code text NOT NULL, name text NOT NULL,
  type text NOT NULL CHECK (type IN ('ASSET','LIABILITY','EQUITY','REVENUE','COGS','EXPENSE','OTHER')),
  normal_side text NOT NULL CHECK (normal_side IN ('DEBIT','CREDIT')),
  is_postable boolean NOT NULL DEFAULT true, is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, code)
);

CREATE TABLE accounting_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  start_date date NOT NULL, end_date date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  closed_by uuid REFERENCES users(id), closed_at timestamptz,
  CHECK (end_date >= start_date), UNIQUE (company_id, start_date)
);

CREATE TABLE document_sequences (                    -- gapless numbering, locked at posting
  company_id uuid NOT NULL REFERENCES companies(id),
  doc_type text NOT NULL, fiscal_year int NOT NULL,
  prefix text NOT NULL, last_number bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, doc_type, fiscal_year)
);

CREATE FUNCTION next_document_number(p_company uuid, p_type text, p_year int) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE r document_sequences;
BEGIN
  UPDATE document_sequences SET last_number = last_number + 1
   WHERE company_id = p_company AND doc_type = p_type AND fiscal_year = p_year
   RETURNING * INTO r;                               -- row lock held until COMMIT => no gaps/duplicates
  IF NOT FOUND THEN RAISE EXCEPTION 'SEQUENCE_NOT_CONFIGURED %', p_type; END IF;
  RETURN r.prefix || '-' || p_year || '-' || lpad(r.last_number::text, 6, '0');
END $$;

-- ------------------------------ 2. Parties ----------------------------------
CREATE TABLE partners (                              -- the two profit-sharing parties
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL, kind text NOT NULL CHECK (kind IN ('OWNER','PARTNER')),
  share_percent numeric(5,2) NOT NULL CHECK (share_percent BETWEEN 0 AND 100),
  funds_capital boolean NOT NULL DEFAULT false,
  user_id uuid REFERENCES users(id),                 -- owner has a login; partner does not
  UNIQUE (company_id, kind)
);

CREATE TABLE contacts (                              -- customers and suppliers
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  kind text NOT NULL CHECK (kind IN ('CUSTOMER','SUPPLIER','BOTH')),
  code text NOT NULL, name text NOT NULL, phones text[], address text,
  payment_terms_days int NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  credit_limit numeric(20,4) CHECK (credit_limit >= 0),
  is_archived boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  UNIQUE (company_id, code)
);

CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL, monthly_salary numeric(20,4) NOT NULL CHECK (monthly_salary >= 0),
  currency char(3) NOT NULL REFERENCES currencies(code), is_active boolean NOT NULL DEFAULT true
);

-- ------------------------------ 3. Products & inventory ---------------------
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  code text NOT NULL, name text NOT NULL, description text, specs jsonb, item_type text,
  base_uom text NOT NULL, qty_decimals smallint NOT NULL DEFAULT 0 CHECK (qty_decimals BETWEEN 0 AND 6),
  default_purchase_price numeric(20,4) CHECK (default_purchase_price >= 0),
  default_sale_price numeric(20,4) CHECK (default_sale_price >= 0),
  default_currency char(3) REFERENCES currencies(code),
  is_archived boolean NOT NULL DEFAULT false,      -- archive, never delete once movements exist
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  UNIQUE (company_id, code)
);

CREATE TABLE product_uoms (                          -- per-product conversions: NOT a global constant
  product_id uuid NOT NULL REFERENCES products(id),
  uom text NOT NULL, factor_to_base numeric(20,6) NOT NULL CHECK (factor_to_base > 0),
  PRIMARY KEY (product_id, uom)
);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  entity_type text NOT NULL, entity_id uuid NOT NULL,
  storage_path text NOT NULL, sha256 char(64) NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes int NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  uploaded_by uuid NOT NULL REFERENCES users(id), uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON attachments(company_id, entity_type, entity_id);

CREATE TABLE product_images (
  product_id uuid NOT NULL REFERENCES products(id),
  attachment_id uuid NOT NULL REFERENCES attachments(id),
  sort_order int NOT NULL DEFAULT 0, PRIMARY KEY (product_id, attachment_id)
);

CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL, kind text NOT NULL CHECK (kind IN ('MAIN','PARTNER_CUSTODY')),
  UNIQUE (company_id, kind)
);

CREATE TABLE stock_locations (                       -- FIFO is tracked per (product, location)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id), name text NOT NULL,
  UNIQUE (warehouse_id, name)
);

-- FIFO layers
CREATE TABLE stock_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  product_id uuid NOT NULL REFERENCES products(id),
  location_id uuid NOT NULL REFERENCES stock_locations(id),
  source_lot_id uuid REFERENCES stock_lots(id),    -- set when created by a transfer
  origin_doc_type text NOT NULL, origin_doc_id uuid NOT NULL,
  received_at timestamptz NOT NULL,                -- preserved across transfers => true FIFO order
  qty_received numeric(20,6) NOT NULL CHECK (qty_received > 0),
  qty_remaining numeric(20,6) NOT NULL,
  unit_cost_base numeric(20,4) NOT NULL CHECK (unit_cost_base >= 0),
  unit_cost_orig numeric(20,4) NOT NULL, currency char(3) NOT NULL REFERENCES currencies(code),
  fx_rate_snapshot numeric(18,8) NOT NULL CHECK (fx_rate_snapshot > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (qty_remaining >= 0),                      -- DB-level ban on negative stock
  CHECK (qty_remaining <= qty_received)
);
CREATE INDEX stock_lots_fifo_idx ON stock_lots (product_id, location_id, received_at, id) WHERE qty_remaining > 0;

CREATE TABLE stock_lot_consumptions (                -- links every outflow to the exact layer + cost
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  lot_id uuid NOT NULL REFERENCES stock_lots(id),
  doc_type text NOT NULL, doc_id uuid NOT NULL, doc_line_id uuid NOT NULL,
  qty numeric(20,6) NOT NULL CHECK (qty > 0),
  unit_cost_base numeric(20,4) NOT NULL,
  reversed_by_id uuid REFERENCES stock_lot_consumptions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON stock_lot_consumptions(doc_type, doc_id);
CREATE INDEX ON stock_lot_consumptions(lot_id);

CREATE TABLE stock_movements (                       -- append-only stock ledger
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  product_id uuid NOT NULL REFERENCES products(id),
  location_id uuid NOT NULL REFERENCES stock_locations(id),
  lot_id uuid REFERENCES stock_lots(id),
  movement_type text NOT NULL CHECK (movement_type IN
    ('PURCHASE_IN','SALE_OUT','TRANSFER_OUT','TRANSFER_IN','SALE_RETURN_IN','PURCHASE_RETURN_OUT','COUNT_ADJ','OPENING')),
  qty_base numeric(20,6) NOT NULL CHECK (qty_base <> 0),    -- signed
  unit_cost_base numeric(20,4) NOT NULL,
  doc_type text NOT NULL, doc_id uuid NOT NULL,
  moved_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON stock_movements(company_id, product_id, location_id, moved_at);

-- ------------------------------ 4. Journal (double entry) -------------------
CREATE TABLE journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  entry_no text NOT NULL, entry_date date NOT NULL,
  source_doc_type text NOT NULL, source_doc_id uuid NOT NULL,
  reverses_entry_id uuid REFERENCES journal_entries(id),
  memo text, posted_by uuid NOT NULL REFERENCES users(id), posted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, entry_no)
);
CREATE INDEX ON journal_entries(source_doc_type, source_doc_id);

CREATE TABLE journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  entry_id uuid NOT NULL REFERENCES journal_entries(id),
  line_no int NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  debit_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (debit_base >= 0),
  credit_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (credit_base >= 0),
  currency char(3) NOT NULL REFERENCES currencies(code),
  amount_orig numeric(20,4) NOT NULL CHECK (amount_orig >= 0),
  fx_rate_snapshot numeric(18,8) NOT NULL CHECK (fx_rate_snapshot > 0),
  contact_id uuid REFERENCES contacts(id), partner_id uuid REFERENCES partners(id),
  memo text,
  CHECK ((debit_base > 0 AND credit_base = 0) OR (credit_base > 0 AND debit_base = 0)),
  UNIQUE (entry_id, line_no)
);
CREATE INDEX ON journal_lines(account_id);
CREATE INDEX ON journal_lines(contact_id) WHERE contact_id IS NOT NULL;

-- Σdebit = Σcredit per entry, checked at COMMIT (deferred), and ≥ 2 lines.
CREATE FUNCTION assert_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric; c numeric; n int;
BEGIN
  SELECT coalesce(sum(debit_base),0), coalesce(sum(credit_base),0), count(*)
    INTO d, c, n FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF d <> c THEN RAISE EXCEPTION 'UNBALANCED_ENTRY % debit=% credit=%', NEW.entry_id, d, c; END IF;
  IF n < 2 THEN RAISE EXCEPTION 'ENTRY_NEEDS_TWO_LINES %', NEW.entry_id; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT ON journal_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- Journal is immutable: corrections are reversing entries only.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_TABLE % (% not allowed)', TG_TABLE_NAME, TG_OP; END $$;
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ------------------------------ 5. Cash -------------------------------------
CREATE TABLE cash_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  name text NOT NULL, currency char(3) NOT NULL REFERENCES currencies(code),
  kind text NOT NULL CHECK (kind IN ('MAIN_CASH','BANK','PARTNER_CUSTODY','TRANSITIONAL')),
  counts_toward_available_cash boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  CHECK (kind IN ('MAIN_CASH','BANK') OR counts_toward_available_cash = false)
);

-- ------------------------------ 6. Document header template ----------------
-- Every business document shares: draft_ref/doc_no, doc_date, currency, fx snapshot,
-- status, version, audit fields, reverses_id, journal_entry_id.
-- doc_no is NULL until POSTED. Business uniqueness: (company_id, doc_no).

-- Purchases
CREATE TABLE purchase_orders (                       -- supplier invoice / purchase document
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  supplier_id uuid NOT NULL REFERENCES contacts(id),
  payment_type text NOT NULL CHECK (payment_type IN ('CASH','CREDIT')),
  due_date date,
  currency char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  subtotal numeric(20,4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  total numeric(20,4) NOT NULL DEFAULT 0 CHECK (total >= 0),
  total_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (total_base >= 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1, notes text,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES users(id), posted_at timestamptz,
  reverses_id uuid REFERENCES purchase_orders(id), journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL)),
  CHECK (posted_by IS NULL OR posted_by IS NOT NULL)
);
CREATE UNIQUE INDEX ON purchase_orders(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON purchase_orders(company_id, draft_ref);

CREATE TABLE purchase_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  purchase_id uuid NOT NULL REFERENCES purchase_orders(id), line_no int NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id),
  uom text NOT NULL, qty numeric(20,6) NOT NULL CHECK (qty > 0),
  qty_base numeric(20,6) NOT NULL CHECK (qty_base > 0),
  unit_price numeric(20,4) NOT NULL CHECK (unit_price >= 0),
  line_total numeric(20,4) NOT NULL CHECK (line_total >= 0),
  location_id uuid NOT NULL REFERENCES stock_locations(id),
  UNIQUE (purchase_id, line_no)
);

CREATE TABLE purchase_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  purchase_id uuid NOT NULL REFERENCES purchase_orders(id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), posted_by uuid REFERENCES users(id), posted_at timestamptz,
  reverses_id uuid REFERENCES purchase_receipts(id), journal_entry_id uuid REFERENCES journal_entries(id)
);
CREATE UNIQUE INDEX ON purchase_receipts(company_id, doc_no) WHERE doc_no IS NOT NULL;

CREATE TABLE purchase_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  purchase_id uuid NOT NULL REFERENCES purchase_orders(id),
  lot_id uuid REFERENCES stock_lots(id),           -- original layer being returned
  qty_base numeric(20,6) NOT NULL CHECK (qty_base > 0),
  refund_value numeric(20,4) NOT NULL CHECK (refund_value >= 0),
  exceptional_reason text,                         -- required if qty exceeds layer remaining
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), posted_by uuid REFERENCES users(id), posted_at timestamptz,
  reverses_id uuid REFERENCES purchase_returns(id), journal_entry_id uuid REFERENCES journal_entries(id)
);
CREATE UNIQUE INDEX ON purchase_returns(company_id, doc_no) WHERE doc_no IS NOT NULL;

CREATE TABLE supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  supplier_id uuid NOT NULL REFERENCES contacts(id),
  cash_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  currency char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), amount_base numeric(20,4) NOT NULL CHECK (amount_base > 0),
  fx_diff_base numeric(20,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), posted_by uuid REFERENCES users(id), posted_at timestamptz,
  reverses_id uuid REFERENCES supplier_payments(id), journal_entry_id uuid REFERENCES journal_entries(id)
);
CREATE UNIQUE INDEX ON supplier_payments(company_id, doc_no) WHERE doc_no IS NOT NULL;

CREATE TABLE supplier_payment_allocations (
  payment_id uuid NOT NULL REFERENCES supplier_payments(id),
  purchase_id uuid NOT NULL REFERENCES purchase_orders(id),
  amount numeric(20,4) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (payment_id, purchase_id)
);

-- Sales
CREATE TABLE sales_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL, valid_until date,
  customer_id uuid NOT NULL REFERENCES contacts(id),
  currency char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  total numeric(20,4) NOT NULL DEFAULT 0, terms text, notes text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENT','ACCEPTED','EXPIRED','CONVERTED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON sales_quotes(company_id, doc_no) WHERE doc_no IS NOT NULL;

CREATE TABLE sales_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,            -- doc_date = fiscal date
  event_date date,                                  -- actual sale date when entered later by accountant (C-6)
  customer_id uuid NOT NULL REFERENCES contacts(id),
  sale_type text NOT NULL CHECK (sale_type IN ('CASH','CREDIT')),
  due_date date, quote_id uuid REFERENCES sales_quotes(id),
  currency char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  gross numeric(20,4) NOT NULL DEFAULT 0 CHECK (gross >= 0),
  discount numeric(20,4) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  net numeric(20,4) NOT NULL DEFAULT 0 CHECK (net >= 0), net_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (net_base >= 0),
  cogs_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (cogs_base >= 0),
  terms text, notes text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), posted_by uuid REFERENCES users(id), posted_at timestamptz,
  reverses_id uuid REFERENCES sales_invoices(id), journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK (discount <= gross),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL))
);
CREATE UNIQUE INDEX ON sales_invoices(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON sales_invoices(company_id, draft_ref);

CREATE TABLE sales_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  invoice_id uuid NOT NULL REFERENCES sales_invoices(id), line_no int NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id),
  uom text NOT NULL, qty numeric(20,6) NOT NULL CHECK (qty > 0), qty_base numeric(20,6) NOT NULL CHECK (qty_base > 0),
  unit_price numeric(20,4) NOT NULL CHECK (unit_price >= 0),
  line_discount numeric(20,4) NOT NULL DEFAULT 0 CHECK (line_discount >= 0),
  line_total numeric(20,4) NOT NULL CHECK (line_total >= 0),
  location_id uuid NOT NULL REFERENCES stock_locations(id),
  UNIQUE (invoice_id, line_no)
);

CREATE TABLE delivery_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  invoice_id uuid NOT NULL REFERENCES sales_invoices(id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), posted_by uuid REFERENCES users(id), posted_at timestamptz,
  reverses_id uuid REFERENCES delivery_notes(id), journal_entry_id uuid REFERENCES journal_entries(id)
);
CREATE UNIQUE INDEX ON delivery_notes(company_id, doc_no) WHERE doc_no IS NOT NULL;

CREATE TABLE sales_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  invoice_id uuid NOT NULL REFERENCES sales_invoices(id),
  return_value numeric(20,4) NOT NULL CHECK (return_value > 0),
  return_cogs_base numeric(20,4) NOT NULL CHECK (return_cogs_base >= 0),
  settlement text NOT NULL CHECK (settlement IN ('REDUCE_RECEIVABLE','CUSTOMER_CREDIT','CASH_REFUND')),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), posted_by uuid REFERENCES users(id), posted_at timestamptz,
  reverses_id uuid REFERENCES sales_returns(id), journal_entry_id uuid REFERENCES journal_entries(id)
);
CREATE UNIQUE INDEX ON sales_returns(company_id, doc_no) WHERE doc_no IS NOT NULL;

CREATE TABLE customer_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  customer_id uuid NOT NULL REFERENCES contacts(id),
  received_into_account_id uuid NOT NULL REFERENCES cash_accounts(id),   -- main cash OR partner custody
  currency char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), amount_base numeric(20,4) NOT NULL CHECK (amount_base > 0),
  fx_diff_base numeric(20,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), posted_by uuid REFERENCES users(id), posted_at timestamptz,
  reverses_id uuid REFERENCES customer_receipts(id), journal_entry_id uuid REFERENCES journal_entries(id)
);
CREATE UNIQUE INDEX ON customer_receipts(company_id, doc_no) WHERE doc_no IS NOT NULL;

CREATE TABLE receipt_allocations (                   -- how a receipt is applied to invoices
  receipt_id uuid NOT NULL REFERENCES customer_receipts(id),
  invoice_id uuid NOT NULL REFERENCES sales_invoices(id),
  amount numeric(20,4) NOT NULL CHECK (amount > 0),
  amount_base_at_invoice_rate numeric(20,4) NOT NULL CHECK (amount_base_at_invoice_rate > 0),
  PRIMARY KEY (receipt_id, invoice_id)
);

CREATE TABLE cash_transfers (                        -- includes partner custody -> main cash (no double collection)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  from_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  to_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), currency char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), posted_by uuid REFERENCES users(id), posted_at timestamptz,
  reverses_id uuid REFERENCES cash_transfers(id), journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK (from_account_id <> to_account_id)
);
CREATE UNIQUE INDEX ON cash_transfers(company_id, doc_no) WHERE doc_no IS NOT NULL;

CREATE TABLE cash_movements (                        -- append-only cash sub-ledger
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  cash_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  amount numeric(20,4) NOT NULL CHECK (amount <> 0),      -- signed, in the account currency
  amount_base numeric(20,4) NOT NULL,
  doc_type text NOT NULL, doc_id uuid NOT NULL, moved_at timestamptz NOT NULL
);
CREATE INDEX ON cash_movements(cash_account_id, moved_at);
CREATE TRIGGER cash_movements_immutable BEFORE UPDATE OR DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE inventory_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  location_id uuid NOT NULL REFERENCES stock_locations(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), posted_by uuid REFERENCES users(id), posted_at timestamptz,
  reverses_id uuid REFERENCES inventory_counts(id), journal_entry_id uuid REFERENCES journal_entries(id)
);
CREATE UNIQUE INDEX ON inventory_counts(company_id, doc_no) WHERE doc_no IS NOT NULL;

CREATE TABLE inventory_count_lines (
  count_id uuid NOT NULL REFERENCES inventory_counts(id),
  product_id uuid NOT NULL REFERENCES products(id),
  system_qty_base numeric(20,6) NOT NULL, counted_qty_base numeric(20,6) NOT NULL CHECK (counted_qty_base >= 0),
  PRIMARY KEY (count_id, product_id)
);

-- ------------------------------ 7. Expenses & payroll -----------------------
CREATE TABLE expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL, nature text NOT NULL CHECK (nature IN ('FIXED','VARIABLE')),
  scope text NOT NULL CHECK (scope IN ('DIRECT','GENERAL')),
  account_id uuid NOT NULL REFERENCES accounts(id), UNIQUE (company_id, name)
);

CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  category_id uuid NOT NULL REFERENCES expense_categories(id),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), currency char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  amount_base numeric(20,4) NOT NULL CHECK (amount_base > 0),
  payment_mode text NOT NULL CHECK (payment_mode IN ('PAID_CASH','ACCRUED','PAID_BY_PARTNER')),
  cash_account_id uuid REFERENCES cash_accounts(id),
  partner_treatment text CHECK (partner_treatment IN ('PAYABLE_TO_PARTNER','OFFSET_AGAINST_PROFIT')),
  settled_in_settlement_id uuid,                      -- set once consumed by a profit settlement (once only)
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), posted_by uuid REFERENCES users(id), posted_at timestamptz,
  reverses_id uuid REFERENCES expenses(id), journal_entry_id uuid REFERENCES journal_entries(id),
  -- no duplicate recording: a partner-paid expense must declare exactly ONE treatment
  CHECK ((payment_mode = 'PAID_BY_PARTNER') = (partner_treatment IS NOT NULL)),
  CHECK (payment_mode <> 'PAID_CASH' OR cash_account_id IS NOT NULL)
);
CREATE UNIQUE INDEX ON expenses(company_id, doc_no) WHERE doc_no IS NOT NULL;

CREATE TABLE payroll_accruals (                      -- monthly, accrues even if unpaid
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  period_month date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  amount numeric(20,4) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  journal_entry_id uuid REFERENCES journal_entries(id), settled_in_settlement_id uuid,
  UNIQUE (employee_id, period_month)                -- one accrual per employee per month
);

CREATE TABLE payroll_payments (                      -- reduces the liability only, never an expense
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  accrual_id uuid NOT NULL REFERENCES payroll_accruals(id),
  cash_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), paid_at date NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  journal_entry_id uuid REFERENCES journal_entries(id)
);

-- ------------------------------ 8. Capital, personal, partner ledger -------
CREATE TABLE capital_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  doc_no text, doc_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('INJECTION','WITHDRAWAL')),
  partner_id uuid NOT NULL REFERENCES partners(id),
  cash_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), currency char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  amount_base numeric(20,4) NOT NULL CHECK (amount_base > 0),
  requested_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),             -- must be the owner (enforced in service + trigger below)
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','REQUESTED','APPROVED','POSTED','REJECTED','REVERSED')),
  version int NOT NULL DEFAULT 1, reason text,
  created_at timestamptz NOT NULL DEFAULT now(), journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);
CREATE UNIQUE INDEX ON capital_transactions(company_id, doc_no) WHERE doc_no IS NOT NULL;

-- Only the owner may be the approver of any capital transaction.
CREATE FUNCTION assert_capital_approver_is_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.approved_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.approved_by AND is_owner)
  THEN RAISE EXCEPTION 'CAPITAL_APPROVAL_OWNER_ONLY'; END IF;
  IF NEW.kind = 'INJECTION' AND NOT EXISTS (SELECT 1 FROM partners WHERE id = NEW.partner_id AND funds_capital)
  THEN RAISE EXCEPTION 'ONLY_OWNER_FUNDS_CAPITAL'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capital_owner_only BEFORE INSERT OR UPDATE ON capital_transactions
  FOR EACH ROW EXECUTE FUNCTION assert_capital_approver_is_owner();

CREATE TABLE personal_advances (                     -- personal draws & person-to-person debts (not operating)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  doc_date date NOT NULL, partner_id uuid NOT NULL REFERENCES partners(id),
  kind text NOT NULL CHECK (kind IN ('PERSONAL_DRAW','PERSON_LOAN','PERSON_REPAYMENT')),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), currency char(3) NOT NULL REFERENCES currencies(code),
  amount_base numeric(20,4) NOT NULL CHECK (amount_base > 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), journal_entry_id uuid REFERENCES journal_entries(id)
);

CREATE TABLE partner_ledger (                        -- append-only statement per partner
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  entry_type text NOT NULL CHECK (entry_type IN
    ('PROFIT_SHARE','PAYOUT','ADVANCE','EXPENSE_PAYABLE','EXPENSE_OFFSET','CAPITAL_IN','CAPITAL_OUT','ADJUSTMENT')),
  amount_base numeric(20,4) NOT NULL CHECK (amount_base <> 0),       -- signed: + owed to partner, - owed by partner
  doc_type text NOT NULL, doc_id uuid NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON partner_ledger(partner_id, occurred_at);
CREATE TRIGGER partner_ledger_immutable BEFORE UPDATE OR DELETE ON partner_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ------------------------------ 9. Profit settlements ----------------------
CREATE TABLE profit_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  doc_no text, period_start date NOT NULL, period_end date NOT NULL,
  eligible_profit numeric(20,4) NOT NULL,             -- E
  accrued_expenses numeric(20,4) NOT NULL CHECK (accrued_expenses >= 0),   -- X
  adjustments numeric(20,4) NOT NULL DEFAULT 0,       -- A
  loss_carried_in numeric(20,4) NOT NULL CHECK (loss_carried_in >= 0),     -- L
  reserved numeric(20,4) NOT NULL DEFAULT 0 CHECK (reserved >= 0),         -- R
  loss_covered numeric(20,4) NOT NULL DEFAULT 0 CHECK (loss_covered >= 0),
  loss_carried_out numeric(20,4) NOT NULL CHECK (loss_carried_out >= 0),   -- L'
  distributable numeric(20,4) NOT NULL CHECK (distributable >= 0),         -- D
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','REVERSED')),
  approved_by uuid REFERENCES users(id), approved_at timestamptz,
  version int NOT NULL DEFAULT 1, created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK (period_end >= period_start),
  CHECK (distributable = 0 OR loss_carried_out = 0),
  CHECK (status <> 'APPROVED' OR approved_by IS NOT NULL)
);
CREATE UNIQUE INDEX ON profit_settlements(company_id, doc_no) WHERE doc_no IS NOT NULL;
-- periods of APPROVED settlements may not overlap (same profit cannot be used across periods)
ALTER TABLE profit_settlements ADD CONSTRAINT no_overlapping_settlements
  EXCLUDE USING gist (company_id WITH =, daterange(period_start, period_end, '[]') WITH &&)
  WHERE (status = 'APPROVED');

CREATE TABLE profit_settlement_shares (
  settlement_id uuid NOT NULL REFERENCES profit_settlements(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  share_amount numeric(20,4) NOT NULL CHECK (share_amount >= 0),
  PRIMARY KEY (settlement_id, partner_id)
);

CREATE TABLE profit_settlement_lines (               -- one line per invoice (or adjustment) per settlement
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id uuid NOT NULL REFERENCES profit_settlements(id),
  invoice_id uuid NOT NULL REFERENCES sales_invoices(id),
  adjusted_profit numeric(20,4) NOT NULL, collected_ratio numeric(9,8) NOT NULL CHECK (collected_ratio BETWEEN 0 AND 1),
  linked_profit numeric(20,4) NOT NULL,               -- cap
  released_before numeric(20,4) NOT NULL,
  newly_released numeric(20,4) NOT NULL,              -- may be negative (returns/refunds)
  released_after numeric(20,4) NOT NULL,
  UNIQUE (settlement_id, invoice_id),
  CHECK (released_after = released_before + newly_released),
  CHECK (released_after <= linked_profit)             -- never release more than collection-linked profit
);

-- the SAME profit can never be reused: released_before must equal the true cumulative
CREATE FUNCTION assert_release_continuity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cum numeric;
BEGIN
  SELECT coalesce(sum(l.newly_released),0) INTO cum
    FROM profit_settlement_lines l JOIN profit_settlements s ON s.id = l.settlement_id
   WHERE l.invoice_id = NEW.invoice_id AND s.status = 'APPROVED';
  IF NEW.released_before <> cum THEN
    RAISE EXCEPTION 'PROFIT_ALREADY_RELEASED invoice=% expected_before=% got=%', NEW.invoice_id, cum, NEW.released_before;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER release_continuity BEFORE INSERT ON profit_settlement_lines
  FOR EACH ROW EXECUTE FUNCTION assert_release_continuity();

CREATE TABLE profit_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  settlement_id uuid NOT NULL REFERENCES profit_settlements(id),
  partner_id uuid NOT NULL REFERENCES partners(id),
  amount numeric(20,4) NOT NULL CHECK (amount > 0),
  advances_deducted numeric(20,4) NOT NULL DEFAULT 0 CHECK (advances_deducted >= 0),
  cash_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')),
  paid_by uuid NOT NULL REFERENCES users(id), paid_at timestamptz NOT NULL DEFAULT now(),
  journal_entry_id uuid REFERENCES journal_entries(id),
  UNIQUE (company_id, idempotency_key)                -- replay => rejected / returns original
);

-- Σ payouts per (settlement, partner) <= that partner's approved share
CREATE FUNCTION assert_payout_within_share() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE share numeric; paid numeric;
BEGIN
  SELECT share_amount INTO share FROM profit_settlement_shares
   WHERE settlement_id = NEW.settlement_id AND partner_id = NEW.partner_id FOR UPDATE;
  IF share IS NULL THEN RAISE EXCEPTION 'NO_SHARE_FOR_PARTNER'; END IF;
  SELECT coalesce(sum(amount),0) INTO paid FROM profit_payouts
   WHERE settlement_id = NEW.settlement_id AND partner_id = NEW.partner_id AND status = 'POSTED';
  IF paid + NEW.amount > share THEN
    RAISE EXCEPTION 'PAYOUT_EXCEEDS_SHARE share=% already_paid=% requested=%', share, paid, NEW.amount;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payout_within_share BEFORE INSERT ON profit_payouts
  FOR EACH ROW EXECUTE FUNCTION assert_payout_within_share();

-- ------------------------------ 10. Opening balances ------------------------
CREATE TABLE opening_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  as_of date NOT NULL, kind text NOT NULL CHECK (kind IN
    ('CAPITAL','CASH','INVENTORY_LAYER','CUSTOMER','SUPPLIER','RETAINED_EARNINGS')),
  account_id uuid REFERENCES accounts(id), contact_id uuid REFERENCES contacts(id),
  product_id uuid REFERENCES products(id), location_id uuid REFERENCES stock_locations(id),
  qty_base numeric(20,6), unit_cost_base numeric(20,4), received_at timestamptz,
  amount_base numeric(20,4) NOT NULL CHECK (amount_base >= 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED')),
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'INVENTORY_LAYER' OR (product_id IS NOT NULL AND location_id IS NOT NULL
         AND qty_base > 0 AND unit_cost_base IS NOT NULL AND received_at IS NOT NULL))
);

-- ------------------------------ 11. Audit, sync, backups --------------------
CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid REFERENCES users(id), device_id text, ip inet,
  action text NOT NULL, entity_type text NOT NULL, entity_id uuid,
  before_data jsonb, after_data jsonb, reason text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_logs(company_id, entity_type, entity_id, occurred_at);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE sync_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  operation_id uuid NOT NULL,                         -- generated on device
  idempotency_key text NOT NULL, device_id text NOT NULL, user_id uuid NOT NULL REFERENCES users(id),
  entity_type text NOT NULL, entity_local_id uuid NOT NULL,
  op text NOT NULL CHECK (op IN ('CREATE_DRAFT','UPDATE_DRAFT','SUBMIT_FOR_POSTING')),
  base_version int, payload jsonb NOT NULL,
  client_created_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','ACCEPTED','REJECTED','CONFLICT')),
  result_code text, result jsonb,
  UNIQUE (company_id, operation_id), UNIQUE (company_id, idempotency_key)
);

CREATE TABLE sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  operation_id uuid NOT NULL, kind text NOT NULL CHECK (kind IN
    ('VERSION_MISMATCH','INSUFFICIENT_STOCK','INSUFFICIENT_CASH','PERMISSION_CHANGED','PERIOD_CLOSED','DUPLICATE')),
  server_snapshot jsonb, client_snapshot jsonb,
  resolution text CHECK (resolution IN ('KEEP_SERVER','APPLY_CLIENT_AS_NEW_DRAFT','DISCARDED')),
  resolved_by uuid REFERENCES users(id), resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, operation_id) REFERENCES sync_operations(company_id, operation_id)
);

CREATE TABLE backup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  kind text NOT NULL CHECK (kind IN ('DAILY','WEEKLY','MONTHLY','RESTORE_TEST')),
  started_at timestamptz NOT NULL, finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('RUNNING','OK','FAILED')),
  size_bytes bigint, sha256 char(64), remote_location text, error text
);

-- ------------------------------ 12. Posted-document immutability -----------
-- A POSTED document can only transition to REVERSED, with no other column changed.
-- DELETE allowed only while DRAFT.
CREATE FUNCTION guard_document_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o jsonb; n jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'ONLY_DRAFT_CAN_BE_DELETED %', TG_TABLE_NAME; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('POSTED','APPROVED') THEN
    IF NEW.status = 'REVERSED' THEN
      o := to_jsonb(OLD) - 'status' - 'updated_at' - 'version';
      n := to_jsonb(NEW) - 'status' - 'updated_at' - 'version';
      IF o <> n THEN RAISE EXCEPTION 'POSTED_DOCUMENT_IMMUTABLE %', TG_TABLE_NAME; END IF;
    ELSIF to_jsonb(OLD) - 'updated_at' - 'version' - 'settled_in_settlement_id'
        <> to_jsonb(NEW) - 'updated_at' - 'version' - 'settled_in_settlement_id' THEN
      RAISE EXCEPTION 'POSTED_DOCUMENT_IMMUTABLE %', TG_TABLE_NAME;
    END IF;
  ELSIF OLD.status = 'REVERSED' THEN
    RAISE EXCEPTION 'REVERSED_DOCUMENT_IMMUTABLE %', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_orders','purchase_receipts','purchase_returns','supplier_payments',
    'sales_invoices','delivery_notes','sales_returns','customer_receipts','cash_transfers','inventory_counts',
    'expenses','payroll_accruals','payroll_payments','capital_transactions','personal_advances','profit_settlements']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_document_lifecycle()',
                   t || '_lifecycle', t);
  END LOOP;
END $$;

-- Lines of a non-DRAFT parent cannot change.
CREATE FUNCTION guard_line_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text; fk uuid;
BEGIN
  fk := (to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END) ->> TG_ARGV[1])::uuid;
  EXECUTE format('SELECT status FROM %I WHERE id = $1', TG_ARGV[0]) INTO parent_status USING fk;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'LINES_LOCKED_PARENT_NOT_DRAFT %', TG_TABLE_NAME;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER purchase_lines_guard BEFORE UPDATE OR DELETE ON purchase_lines
  FOR EACH ROW EXECUTE FUNCTION guard_line_parent('purchase_orders','purchase_id');
CREATE TRIGGER sales_lines_guard BEFORE UPDATE OR DELETE ON sales_lines
  FOR EACH ROW EXECUTE FUNCTION guard_line_parent('sales_invoices','invoice_id');

-- ------------------------------ 13. Row-Level Security (safety net) ---------
-- App role connects WITHOUT BYPASSRLS and sets: SET LOCAL app.company_id = '<uuid>'.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables tb USING (table_schema, table_name)
           WHERE c.table_schema = 'public' AND c.column_name = 'company_id'
             AND tb.table_type = 'BASE TABLE' AND c.table_name <> 'companies'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$f$, t.table_name);
  END LOOP;
END $$;
