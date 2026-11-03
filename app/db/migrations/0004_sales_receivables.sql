-- Phase 3: sales quotes/invoices, delivery notes (COGS via FIFO), customer receipts & allocations,
-- sales returns (restore the ORIGINAL layers/costs), partner-custody cash hand-over transfers.

-- numbering rows for companies created before this migration (idempotent)
INSERT INTO document_sequences(company_id, doc_type, fiscal_year, prefix)
  SELECT c.id, v.t, extract(year from now())::int, v.p FROM companies c
  CROSS JOIN (VALUES ('sales_invoice','INV'),('sales_quote','QT'),('delivery_note','DN'),('sales_return','SR'),('customer_receipt','RC'),('cash_transfer','TR')) v(t,p)
  ON CONFLICT DO NOTHING;

-- ---------------- quotes ----------------
CREATE TABLE sales_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL, valid_until date,
  customer_id uuid NOT NULL REFERENCES contacts(id),
  currency char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  discount numeric(20,4) NOT NULL DEFAULT 0 CHECK (discount >= 0), total numeric(20,4) NOT NULL DEFAULT 0 CHECK (total >= 0),
  terms text, notes text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENT','ACCEPTED','REJECTED','EXPIRED','CONVERTED')),
  invoice_id uuid, version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'DRAFT') = (doc_no IS NULL))
);
CREATE UNIQUE INDEX ON sales_quotes(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON sales_quotes(company_id, draft_ref);
CREATE TABLE sales_quote_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  quote_id uuid NOT NULL REFERENCES sales_quotes(id), line_no int NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id), uom text NOT NULL,
  qty numeric(20,6) NOT NULL CHECK (qty > 0), unit_price numeric(20,4) NOT NULL CHECK (unit_price >= 0),
  line_discount numeric(20,4) NOT NULL DEFAULT 0 CHECK (line_discount >= 0), line_total numeric(20,4) NOT NULL CHECK (line_total >= 0),
  UNIQUE (quote_id, line_no)
);

-- ---------------- invoices ----------------
CREATE TABLE sales_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  customer_id uuid NOT NULL REFERENCES contacts(id),
  sale_type text NOT NULL CHECK (sale_type IN ('CASH','CREDIT')),
  cash_account_id uuid REFERENCES cash_accounts(id),            -- where a CASH sale is collected (main cash or partner custody)
  due_date date, quote_id uuid REFERENCES sales_quotes(id),
  delivery_mode text NOT NULL DEFAULT 'WITH_INVOICE' CHECK (delivery_mode IN ('WITH_INVOICE','SEPARATE')),
  currency char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  gross numeric(20,4) NOT NULL DEFAULT 0 CHECK (gross >= 0), discount numeric(20,4) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  net numeric(20,4) NOT NULL DEFAULT 0 CHECK (net >= 0),
  gross_base numeric(20,4) NOT NULL DEFAULT 0, discount_base numeric(20,4) NOT NULL DEFAULT 0, net_base numeric(20,4) NOT NULL DEFAULT 0,
  event_date date,                                              -- actual sale date when the accountant records it later (partner sells outside the system)
  terms text, notes text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES users(id), posted_at timestamptz, journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK (discount <= gross),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL)),
  CHECK (sale_type <> 'CASH' OR cash_account_id IS NOT NULL)
);
CREATE UNIQUE INDEX ON sales_invoices(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON sales_invoices(company_id, draft_ref);
ALTER TABLE sales_quotes ADD CONSTRAINT quote_invoice_fk FOREIGN KEY (invoice_id) REFERENCES sales_invoices(id);

CREATE TABLE sales_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  invoice_id uuid NOT NULL REFERENCES sales_invoices(id), line_no int NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id), uom text NOT NULL,
  qty numeric(20,6) NOT NULL CHECK (qty > 0), qty_base numeric(20,6) NOT NULL CHECK (qty_base > 0),
  unit_price numeric(20,4) NOT NULL CHECK (unit_price >= 0),
  line_discount numeric(20,4) NOT NULL DEFAULT 0 CHECK (line_discount >= 0),
  line_total numeric(20,4) NOT NULL CHECK (line_total >= 0),          -- after line discount, before invoice-level discount
  location_id uuid NOT NULL REFERENCES stock_locations(id),
  line_total_base numeric(20,4) NOT NULL DEFAULT 0,
  net_line_orig numeric(20,4) NOT NULL DEFAULT 0, net_line_base numeric(20,4) NOT NULL DEFAULT 0,   -- after invoice-level discount share
  UNIQUE (invoice_id, line_no)
);

-- ---------------- delivery notes ----------------
CREATE TABLE delivery_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  invoice_id uuid NOT NULL REFERENCES sales_invoices(id), auto_created boolean NOT NULL DEFAULT false,
  recipient_note text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES users(id), posted_at timestamptz, journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL))
);
CREATE UNIQUE INDEX ON delivery_notes(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON delivery_notes(company_id, draft_ref);
CREATE TABLE delivery_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  delivery_id uuid NOT NULL REFERENCES delivery_notes(id), line_no int NOT NULL,
  sales_line_id uuid NOT NULL REFERENCES sales_lines(id),
  qty_base numeric(20,6) NOT NULL CHECK (qty_base > 0), cost_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (cost_base >= 0),
  UNIQUE (delivery_id, line_no)
);

-- ---------------- sales returns ----------------
CREATE TABLE sales_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  invoice_id uuid NOT NULL REFERENCES sales_invoices(id), reason text NOT NULL,
  settlement text NOT NULL CHECK (settlement IN ('REDUCE_RECEIVABLE','CASH_REFUND')),   -- excess over what is owed becomes customer credit (or is refunded)
  cash_account_id uuid REFERENCES cash_accounts(id),
  value_orig numeric(20,4) NOT NULL DEFAULT 0 CHECK (value_orig >= 0), value_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (value_base >= 0),
  applied_orig numeric(20,4) NOT NULL DEFAULT 0 CHECK (applied_orig >= 0),             -- part that reduced the receivable
  credit_orig numeric(20,4) NOT NULL DEFAULT 0 CHECK (credit_orig >= 0),               -- part that became customer credit
  refund_orig numeric(20,4) NOT NULL DEFAULT 0 CHECK (refund_orig >= 0),               -- part refunded in cash
  cogs_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (cogs_base >= 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES users(id), posted_at timestamptz, journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL)),
  CHECK (settlement <> 'CASH_REFUND' OR cash_account_id IS NOT NULL)
);
CREATE UNIQUE INDEX ON sales_returns(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON sales_returns(company_id, draft_ref);
CREATE TABLE sales_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  return_id uuid NOT NULL REFERENCES sales_returns(id), line_no int NOT NULL,
  sales_line_id uuid NOT NULL REFERENCES sales_lines(id),
  qty_base numeric(20,6) NOT NULL CHECK (qty_base > 0),
  value_orig numeric(20,4) NOT NULL DEFAULT 0, value_base numeric(20,4) NOT NULL DEFAULT 0, cost_base numeric(20,4) NOT NULL DEFAULT 0,
  UNIQUE (return_id, line_no)
);
-- which original layers a return put stock back into (so a line can never restore more than it consumed)
CREATE TABLE stock_lot_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  lot_id uuid NOT NULL REFERENCES stock_lots(id), delivery_line_id uuid NOT NULL REFERENCES delivery_lines(id),
  return_id uuid NOT NULL REFERENCES sales_returns(id),
  qty numeric(20,6) NOT NULL CHECK (qty > 0), cost_base numeric(20,4) NOT NULL CHECK (cost_base >= 0)
);
CREATE INDEX ON stock_lot_returns(delivery_line_id); CREATE INDEX ON stock_lot_returns(return_id);
CREATE TRIGGER stock_lot_returns_immutable BEFORE UPDATE OR DELETE ON stock_lot_returns FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------- receipts (cash in) & credit applications ----------------
CREATE TABLE customer_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  kind text NOT NULL DEFAULT 'CASH' CHECK (kind IN ('CASH','CREDIT_APPLICATION')),
  customer_id uuid NOT NULL REFERENCES contacts(id),
  cash_account_id uuid REFERENCES cash_accounts(id),             -- main cash OR partner custody; NULL for credit applications
  auto_for_invoice_id uuid REFERENCES sales_invoices(id),        -- receipt created by a CASH sale
  currency char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), amount_base numeric(20,4) NOT NULL DEFAULT 0, fx_diff_base numeric(20,4) NOT NULL DEFAULT 0,
  notes text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES users(id), posted_at timestamptz, journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL)),
  CHECK ((kind = 'CASH') = (cash_account_id IS NOT NULL))
);
CREATE UNIQUE INDEX ON customer_receipts(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON customer_receipts(company_id, draft_ref);
CREATE TABLE receipt_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  receipt_id uuid NOT NULL REFERENCES customer_receipts(id), invoice_id uuid NOT NULL REFERENCES sales_invoices(id),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), UNIQUE (receipt_id, invoice_id)
);

-- ---------------- cash transfers (partner custody -> main cash: NOT a second collection) ----------------
CREATE TABLE cash_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  from_account_id uuid NOT NULL REFERENCES cash_accounts(id), to_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  currency char(3) NOT NULL REFERENCES currencies(code), exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), notes text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES users(id), posted_at timestamptz, journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK (from_account_id <> to_account_id), CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL))
);
CREATE UNIQUE INDEX ON cash_transfers(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON cash_transfers(company_id, draft_ref);

-- ---------------- lifecycle guards ----------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_invoices','delivery_notes','sales_returns','customer_receipts','cash_transfers'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_document_lifecycle()', t || '_lifecycle', t);
  END LOOP;
END $$;
CREATE TRIGGER sales_lines_guard BEFORE UPDATE OR DELETE ON sales_lines FOR EACH ROW EXECUTE FUNCTION guard_line_parent('sales_invoices','invoice_id');
CREATE TRIGGER delivery_lines_guard BEFORE UPDATE OR DELETE ON delivery_lines FOR EACH ROW EXECUTE FUNCTION guard_line_parent('delivery_notes','delivery_id');
CREATE TRIGGER sales_return_lines_guard BEFORE UPDATE OR DELETE ON sales_return_lines FOR EACH ROW EXECUTE FUNCTION guard_line_parent('sales_returns','return_id');
CREATE TRIGGER receipt_alloc_guard BEFORE UPDATE OR DELETE ON receipt_allocations FOR EACH ROW EXECUTE FUNCTION guard_line_parent('customer_receipts','receipt_id');
CREATE TRIGGER quote_lines_guard BEFORE UPDATE OR DELETE ON sales_quote_lines FOR EACH ROW EXECUTE FUNCTION guard_line_parent('sales_quotes','quote_id');

-- quotes: only DRAFT is editable/deletable; after issue the commercial content is frozen (status moves forward only)
CREATE FUNCTION guard_quote() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'ONLY_DRAFT_CAN_BE_DELETED sales_quotes'; END IF; RETURN OLD; END IF;
  IF OLD.status <> 'DRAFT' AND (to_jsonb(OLD) - 'status' - 'updated_at' - 'version' - 'invoice_id') <> (to_jsonb(NEW) - 'status' - 'updated_at' - 'version' - 'invoice_id') THEN
    RAISE EXCEPTION 'ISSUED_QUOTE_IMMUTABLE'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_quotes_guard BEFORE UPDATE OR DELETE ON sales_quotes FOR EACH ROW EXECUTE FUNCTION guard_quote();

-- ---------------- RLS ----------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_quotes','sales_quote_lines','sales_invoices','sales_lines','delivery_notes','delivery_lines','sales_returns','sales_return_lines',
                           'stock_lot_returns','customer_receipts','receipt_allocations','cash_transfers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$f$, t);
  END LOOP;
END $$;
