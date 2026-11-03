-- Phase 2: contacts, products/UoM, two stock locations, FIFO lots, journal (double entry),
-- cash accounts, purchases (+returns, supplier payments), stock transfers, inventory counts.
-- Money NUMERIC only; no ON DELETE CASCADE; posted documents immutable (reversal by counter-entry only).

-- ------------------------------ numbering: auto-open a new fiscal year ------------------------------
CREATE OR REPLACE FUNCTION next_document_number(p_company uuid, p_type text, p_year int) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE r document_sequences; pfx text;
BEGIN
  UPDATE document_sequences SET last_number = last_number + 1
   WHERE company_id = p_company AND doc_type = p_type AND fiscal_year = p_year RETURNING * INTO r;
  IF NOT FOUND THEN
    SELECT prefix INTO pfx FROM document_sequences WHERE company_id = p_company AND doc_type = p_type ORDER BY fiscal_year DESC LIMIT 1;
    IF pfx IS NULL THEN RAISE EXCEPTION 'SEQUENCE_NOT_CONFIGURED %', p_type; END IF;
    INSERT INTO document_sequences(company_id, doc_type, fiscal_year, prefix, last_number) VALUES (p_company, p_type, p_year, pfx, 0)
      ON CONFLICT DO NOTHING;
    UPDATE document_sequences SET last_number = last_number + 1
     WHERE company_id = p_company AND doc_type = p_type AND fiscal_year = p_year RETURNING * INTO r;
  END IF;
  RETURN r.prefix || '-' || p_year || '-' || lpad(r.last_number::text, 6, '0');
END $$;

-- ------------------------------ parties & catalog ------------------------------
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  kind text NOT NULL CHECK (kind IN ('CUSTOMER','SUPPLIER','BOTH')),
  code text NOT NULL, name text NOT NULL, phones text[], address text,
  payment_terms_days int NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  credit_limit numeric(20,4) CHECK (credit_limit >= 0), notes text,
  is_archived boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  UNIQUE (company_id, code)
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  code text NOT NULL, name text NOT NULL, description text, specs jsonb, item_type text,
  base_uom text NOT NULL, qty_decimals smallint NOT NULL DEFAULT 0 CHECK (qty_decimals BETWEEN 0 AND 6),
  default_purchase_price numeric(20,4) CHECK (default_purchase_price >= 0),
  default_sale_price numeric(20,4) CHECK (default_sale_price >= 0),
  default_currency char(3) REFERENCES currencies(code),
  is_archived boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  UNIQUE (company_id, code)
);

CREATE TABLE product_uoms (          -- per-product conversion: a carton is NOT a global constant
  company_id uuid NOT NULL REFERENCES companies(id),
  product_id uuid NOT NULL REFERENCES products(id),
  uom text NOT NULL, factor_to_base numeric(20,6) NOT NULL CHECK (factor_to_base > 0),
  PRIMARY KEY (product_id, uom)
);

-- ------------------------------ locations ------------------------------
CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL, kind text NOT NULL CHECK (kind IN ('MAIN','PARTNER_CUSTODY')),
  UNIQUE (company_id, kind)
);
CREATE TABLE stock_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id), name text NOT NULL,
  UNIQUE (warehouse_id, name)
);

-- ------------------------------ journal (double entry) ------------------------------
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
CREATE UNIQUE INDEX one_reversal_per_entry ON journal_entries(reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

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
  contact_id uuid REFERENCES contacts(id), partner_id uuid,
  memo text,
  CHECK ((debit_base > 0 AND credit_base = 0) OR (credit_base > 0 AND debit_base = 0)),
  UNIQUE (entry_id, line_no)
);
CREATE INDEX ON journal_lines(account_id);
CREATE INDEX ON journal_lines(contact_id) WHERE contact_id IS NOT NULL;

CREATE FUNCTION assert_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d numeric; c numeric; n int;
BEGIN
  SELECT coalesce(sum(debit_base),0), coalesce(sum(credit_base),0), count(*) INTO d, c, n FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF d <> c THEN RAISE EXCEPTION 'UNBALANCED_ENTRY % debit=% credit=%', NEW.entry_id, d, c; END IF;
  IF n < 2 THEN RAISE EXCEPTION 'ENTRY_NEEDS_TWO_LINES %', NEW.entry_id; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ------------------------------ cash accounts ------------------------------
CREATE TABLE cash_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  name text NOT NULL, currency char(3) NOT NULL REFERENCES currencies(code),
  kind text NOT NULL CHECK (kind IN ('MAIN_CASH','BANK','PARTNER_CUSTODY','TRANSITIONAL')),
  counts_toward_available_cash boolean NOT NULL DEFAULT true, is_active boolean NOT NULL DEFAULT true,
  CHECK (kind IN ('MAIN_CASH','BANK') OR counts_toward_available_cash = false),
  UNIQUE (company_id, account_id)
);
CREATE TABLE cash_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  cash_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  amount numeric(20,4) NOT NULL CHECK (amount <> 0), amount_base numeric(20,4) NOT NULL,
  doc_type text NOT NULL, doc_id uuid NOT NULL, moved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cash_movements(cash_account_id, moved_at);
CREATE TRIGGER cash_movements_immutable BEFORE UPDATE OR DELETE ON cash_movements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ------------------------------ FIFO layers ------------------------------
-- cost_remaining_base is kept EXACT (integer IQD): consuming the whole remainder takes it all, a partial take is
-- proportional and rounded, so  sum(cost_remaining_base) == ledger inventory balance with zero drift.
CREATE TABLE stock_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,          -- deterministic FIFO tie-break (same received_at)
  company_id uuid NOT NULL REFERENCES companies(id),
  product_id uuid NOT NULL REFERENCES products(id),
  location_id uuid NOT NULL REFERENCES stock_locations(id),
  source_lot_id uuid REFERENCES stock_lots(id),
  origin_doc_type text NOT NULL, origin_doc_id uuid NOT NULL, origin_line_id uuid,
  received_at timestamptz NOT NULL,
  qty_received numeric(20,6) NOT NULL CHECK (qty_received > 0),
  qty_remaining numeric(20,6) NOT NULL,
  total_cost_base numeric(20,4) NOT NULL CHECK (total_cost_base >= 0),
  cost_remaining_base numeric(20,4) NOT NULL,
  unit_cost_base numeric(20,4) NOT NULL CHECK (unit_cost_base >= 0),     -- informational: total/qty
  unit_cost_orig numeric(20,4) NOT NULL, currency char(3) NOT NULL REFERENCES currencies(code),
  fx_rate_snapshot numeric(18,8) NOT NULL CHECK (fx_rate_snapshot > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (qty_remaining >= 0), CHECK (qty_remaining <= qty_received),
  CHECK (cost_remaining_base >= 0), CHECK (cost_remaining_base <= total_cost_base),
  CHECK ((qty_remaining = 0) = (cost_remaining_base = 0))
);
CREATE INDEX stock_lots_fifo_idx ON stock_lots (product_id, location_id, received_at, seq) WHERE qty_remaining > 0;
CREATE INDEX ON stock_lots(origin_doc_type, origin_doc_id);
CREATE INDEX ON stock_lots(source_lot_id) WHERE source_lot_id IS NOT NULL;

CREATE TABLE stock_lot_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  lot_id uuid NOT NULL REFERENCES stock_lots(id),
  doc_type text NOT NULL, doc_id uuid NOT NULL, doc_line_id uuid NOT NULL,
  qty numeric(20,6) NOT NULL CHECK (qty > 0),
  cost_base numeric(20,4) NOT NULL CHECK (cost_base >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON stock_lot_consumptions(doc_type, doc_id);
CREATE INDEX ON stock_lot_consumptions(lot_id);
CREATE TRIGGER stock_lot_consumptions_immutable BEFORE UPDATE OR DELETE ON stock_lot_consumptions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  product_id uuid NOT NULL REFERENCES products(id),
  location_id uuid NOT NULL REFERENCES stock_locations(id),
  lot_id uuid REFERENCES stock_lots(id),
  movement_type text NOT NULL CHECK (movement_type IN
    ('PURCHASE_IN','SALE_OUT','TRANSFER_OUT','TRANSFER_IN','SALE_RETURN_IN','PURCHASE_RETURN_OUT','COUNT_ADJ','OPENING','REVERSAL')),
  qty_base numeric(20,6) NOT NULL CHECK (qty_base <> 0),
  cost_base numeric(20,4) NOT NULL,                 -- signed like qty
  doc_type text NOT NULL, doc_id uuid NOT NULL,
  moved_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON stock_movements(company_id, product_id, location_id, moved_at);
CREATE INDEX ON stock_movements(doc_type, doc_id);
CREATE TRIGGER stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ------------------------------ purchases ------------------------------
CREATE TABLE purchase_orders (                       -- supplier invoice + receipt (single step in this phase)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  supplier_id uuid NOT NULL REFERENCES contacts(id),
  supplier_invoice_no text,
  payment_type text NOT NULL CHECK (payment_type IN ('CASH','CREDIT')),
  cash_account_id uuid REFERENCES cash_accounts(id), due_date date,
  currency char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  total numeric(20,4) NOT NULL DEFAULT 0 CHECK (total >= 0),
  total_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (total_base >= 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1, notes text,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES users(id), posted_at timestamptz, journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL)),
  CHECK (payment_type <> 'CASH' OR cash_account_id IS NOT NULL)
);
CREATE UNIQUE INDEX ON purchase_orders(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON purchase_orders(company_id, draft_ref);
CREATE UNIQUE INDEX ON purchase_orders(company_id, supplier_id, supplier_invoice_no) WHERE supplier_invoice_no IS NOT NULL AND status <> 'REVERSED';

CREATE TABLE purchase_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  purchase_id uuid NOT NULL REFERENCES purchase_orders(id), line_no int NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id),
  uom text NOT NULL, qty numeric(20,6) NOT NULL CHECK (qty > 0),
  qty_base numeric(20,6) NOT NULL CHECK (qty_base > 0),
  unit_price numeric(20,4) NOT NULL CHECK (unit_price >= 0),          -- per entered UoM, document currency
  line_total numeric(20,4) NOT NULL CHECK (line_total >= 0),
  line_total_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (line_total_base >= 0),
  location_id uuid NOT NULL REFERENCES stock_locations(id),
  UNIQUE (purchase_id, line_no)
);

CREATE TABLE purchase_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  purchase_id uuid NOT NULL REFERENCES purchase_orders(id),
  settlement text NOT NULL CHECK (settlement IN ('REDUCE_PAYABLE','CASH_REFUND')),
  cash_account_id uuid REFERENCES cash_accounts(id), reason text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES users(id), posted_at timestamptz, journal_entry_id uuid REFERENCES journal_entries(id),
  total_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (total_base >= 0),
  total_orig numeric(20,4) NOT NULL DEFAULT 0 CHECK (total_orig >= 0),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL)),
  CHECK (settlement <> 'CASH_REFUND' OR cash_account_id IS NOT NULL)
);
CREATE UNIQUE INDEX ON purchase_returns(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON purchase_returns(company_id, draft_ref);
CREATE TABLE purchase_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  return_id uuid NOT NULL REFERENCES purchase_returns(id), line_no int NOT NULL,
  purchase_line_id uuid NOT NULL REFERENCES purchase_lines(id),
  qty_base numeric(20,6) NOT NULL CHECK (qty_base > 0),
  shortage_qty_base numeric(20,6) NOT NULL DEFAULT 0 CHECK (shortage_qty_base >= 0),   -- already sold/consumed (exceptional)
  exceptional_reason text,
  cost_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (cost_base >= 0),
  shortage_value_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (shortage_value_base >= 0),
  UNIQUE (return_id, line_no)
);

CREATE TABLE supplier_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  supplier_id uuid NOT NULL REFERENCES contacts(id),
  cash_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  currency char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), amount_base numeric(20,4) NOT NULL DEFAULT 0,
  fx_diff_base numeric(20,4) NOT NULL DEFAULT 0, notes text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES users(id), posted_at timestamptz, journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL))
);
CREATE UNIQUE INDEX ON supplier_payments(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON supplier_payments(company_id, draft_ref);
CREATE TABLE supplier_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  payment_id uuid NOT NULL REFERENCES supplier_payments(id),
  purchase_id uuid NOT NULL REFERENCES purchase_orders(id),
  amount numeric(20,4) NOT NULL CHECK (amount > 0),
  UNIQUE (payment_id, purchase_id)
);

-- ------------------------------ transfers & counts ------------------------------
CREATE TABLE stock_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  from_location_id uuid NOT NULL REFERENCES stock_locations(id),
  to_location_id uuid NOT NULL REFERENCES stock_locations(id), notes text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES users(id), posted_at timestamptz, journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK (from_location_id <> to_location_id),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL))
);
CREATE UNIQUE INDEX ON stock_transfers(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON stock_transfers(company_id, draft_ref);
CREATE TABLE stock_transfer_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  transfer_id uuid NOT NULL REFERENCES stock_transfers(id), line_no int NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id),
  uom text NOT NULL, qty numeric(20,6) NOT NULL CHECK (qty > 0), qty_base numeric(20,6) NOT NULL CHECK (qty_base > 0),
  cost_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (cost_base >= 0),
  UNIQUE (transfer_id, line_no)
);

CREATE TABLE inventory_counts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  location_id uuid NOT NULL REFERENCES stock_locations(id), reason text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES users(id), posted_at timestamptz, journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL))
);
CREATE UNIQUE INDEX ON inventory_counts(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON inventory_counts(company_id, draft_ref);
CREATE TABLE inventory_count_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  count_id uuid NOT NULL REFERENCES inventory_counts(id),
  product_id uuid NOT NULL REFERENCES products(id),
  system_qty_base numeric(20,6) NOT NULL DEFAULT 0, counted_qty_base numeric(20,6) NOT NULL CHECK (counted_qty_base >= 0),
  unit_cost_base numeric(20,4) CHECK (unit_cost_base >= 0),      -- required only for surplus (explicit, owner-approved)
  diff_cost_base numeric(20,4) NOT NULL DEFAULT 0,
  UNIQUE (count_id, product_id)
);

-- ------------------------------ immutability of posted documents ------------------------------
CREATE FUNCTION guard_document_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o jsonb; n jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'ONLY_DRAFT_CAN_BE_DELETED %', TG_TABLE_NAME; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'POSTED' THEN
    IF NEW.status = 'REVERSED' THEN
      o := to_jsonb(OLD) - 'status' - 'updated_at' - 'version'; n := to_jsonb(NEW) - 'status' - 'updated_at' - 'version';
      IF o <> n THEN RAISE EXCEPTION 'POSTED_DOCUMENT_IMMUTABLE %', TG_TABLE_NAME; END IF;
    ELSE RAISE EXCEPTION 'POSTED_DOCUMENT_IMMUTABLE %', TG_TABLE_NAME; END IF;
  ELSIF OLD.status = 'REVERSED' THEN RAISE EXCEPTION 'REVERSED_DOCUMENT_IMMUTABLE %', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION guard_line_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text; fk uuid;
BEGIN
  fk := (to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END) ->> TG_ARGV[1])::uuid;
  EXECUTE format('SELECT status FROM %I WHERE id = $1', TG_ARGV[0]) INTO parent_status USING fk;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'LINES_LOCKED_PARENT_NOT_DRAFT %', TG_TABLE_NAME; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_orders','purchase_returns','supplier_payments','stock_transfers','inventory_counts'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_document_lifecycle()', t || '_lifecycle', t);
  END LOOP;
END $$;
-- Lines: editable only while the parent is DRAFT. (Post-time computed columns are written BEFORE the parent flips.)
CREATE TRIGGER purchase_lines_guard BEFORE UPDATE OR DELETE ON purchase_lines FOR EACH ROW EXECUTE FUNCTION guard_line_parent('purchase_orders','purchase_id');
CREATE TRIGGER purchase_return_lines_guard BEFORE UPDATE OR DELETE ON purchase_return_lines FOR EACH ROW EXECUTE FUNCTION guard_line_parent('purchase_returns','return_id');
CREATE TRIGGER stock_transfer_lines_guard BEFORE UPDATE OR DELETE ON stock_transfer_lines FOR EACH ROW EXECUTE FUNCTION guard_line_parent('stock_transfers','transfer_id');
CREATE TRIGGER inventory_count_lines_guard BEFORE UPDATE OR DELETE ON inventory_count_lines FOR EACH ROW EXECUTE FUNCTION guard_line_parent('inventory_counts','count_id');
CREATE TRIGGER payment_alloc_guard BEFORE UPDATE OR DELETE ON supplier_payment_allocations FOR EACH ROW EXECUTE FUNCTION guard_line_parent('supplier_payments','payment_id');

-- ------------------------------ RLS ------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts','products','product_uoms','warehouses','stock_locations','journal_entries','journal_lines',
    'cash_accounts','cash_movements','stock_lots','stock_lot_consumptions','stock_movements','purchase_orders','purchase_lines',
    'purchase_returns','purchase_return_lines','supplier_payments','supplier_payment_allocations','stock_transfers',
    'stock_transfer_lines','inventory_counts','inventory_count_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$f$, t);
  END LOOP;
END $$;

-- ------------------------------ per-company operational seed (idempotent) ------------------------------
CREATE FUNCTION seed_company_operational(p_company uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE w_main uuid; w_part uuid; a record;
BEGIN
  INSERT INTO warehouses(company_id, name, kind) VALUES (p_company, 'المخزن الرئيسي', 'MAIN') ON CONFLICT (company_id, kind) DO NOTHING;
  INSERT INTO warehouses(company_id, name, kind) VALUES (p_company, 'عهدة الشريك', 'PARTNER_CUSTODY') ON CONFLICT (company_id, kind) DO NOTHING;
  SELECT id INTO w_main FROM warehouses WHERE company_id = p_company AND kind = 'MAIN';
  SELECT id INTO w_part FROM warehouses WHERE company_id = p_company AND kind = 'PARTNER_CUSTODY';
  INSERT INTO stock_locations(company_id, warehouse_id, name) VALUES (p_company, w_main, 'الرئيسي') ON CONFLICT DO NOTHING;
  INSERT INTO stock_locations(company_id, warehouse_id, name) VALUES (p_company, w_part, 'عهدة الشريك') ON CONFLICT DO NOTHING;
  FOR a IN SELECT * FROM (VALUES ('1110','الصندوق الرئيسي IQD','IQD','MAIN_CASH',true), ('1120','الصندوق الرئيسي USD','USD','MAIN_CASH',true),
                                 ('1150','عهدة نقدية — الشريك','IQD','PARTNER_CUSTODY',false)) v(code,name,cur,kind,cnt) LOOP
    INSERT INTO cash_accounts(company_id, account_id, name, currency, kind, counts_toward_available_cash)
      SELECT p_company, ac.id, a.name, a.cur, a.kind, a.cnt FROM accounts ac WHERE ac.company_id = p_company AND ac.code = a.code
      ON CONFLICT (company_id, account_id) DO NOTHING;
  END LOOP;
  INSERT INTO document_sequences(company_id, doc_type, fiscal_year, prefix)
    SELECT p_company, v.t, extract(year from now())::int, v.p FROM (VALUES ('stock_transfer','ST'),('inventory_count','IC')) v(t,p)
    ON CONFLICT DO NOTHING;
END $$;

DO $$ DECLARE c record; BEGIN FOR c IN SELECT id FROM companies LOOP PERFORM seed_company_operational(c.id); END LOOP; END $$;
