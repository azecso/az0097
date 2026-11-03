-- Phase 4: partners, expenses, payroll, capital, personal draws, opening balances, accounting periods,
-- profit settlements & payouts (non-repeatable), owner TOTP columns.

-- ---------------- owner 2FA ----------------
ALTER TABLE users ADD COLUMN totp_secret_enc text, ADD COLUMN totp_enabled boolean NOT NULL DEFAULT false, ADD COLUMN totp_last_step bigint;
-- Replay protection: a TOTP time-step can be consumed only once (atomic compare-and-set).
CREATE FUNCTION auth_totp_use(p_user uuid, p_step bigint) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE users SET totp_last_step = p_step WHERE id = p_user AND (totp_last_step IS NULL OR totp_last_step < p_step);
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n = 1;
END $$;

-- ---------------- partners (the two profit-sharing parties) ----------------
CREATE TABLE partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL, kind text NOT NULL CHECK (kind IN ('OWNER','PARTNER')),
  share_percent numeric(5,2) NOT NULL DEFAULT 50 CHECK (share_percent = 50),          -- SRS: fixed 50/50
  funds_capital boolean NOT NULL DEFAULT false,
  user_id uuid REFERENCES users(id),
  UNIQUE (company_id, kind)
);
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_partner_fk FOREIGN KEY (partner_id) REFERENCES partners(id);
CREATE INDEX ON journal_lines(partner_id) WHERE partner_id IS NOT NULL;

-- ---------------- opening flags on documents (customer/supplier opening balances are real, allocatable documents) ----------------
ALTER TABLE sales_invoices ADD COLUMN is_opening boolean NOT NULL DEFAULT false;
ALTER TABLE purchase_orders ADD COLUMN is_opening boolean NOT NULL DEFAULT false;

-- ---------------- accounting periods (a closed month rejects any posting dated inside it) ----------------
CREATE TABLE accounting_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  period_month date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  status text NOT NULL DEFAULT 'CLOSED' CHECK (status IN ('CLOSED','OPEN')),
  closed_by uuid REFERENCES users(id), closed_at timestamptz, reopened_by uuid REFERENCES users(id), reopened_at timestamptz, reopen_reason text,
  snapshot jsonb, UNIQUE (company_id, period_month)
);

-- ---------------- expenses ----------------
CREATE TABLE expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL, nature text NOT NULL CHECK (nature IN ('FIXED','VARIABLE')), scope text NOT NULL CHECK (scope IN ('DIRECT','GENERAL')),
  account_id uuid NOT NULL REFERENCES accounts(id), is_active boolean NOT NULL DEFAULT true, UNIQUE (company_id, name)
);
CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  category_id uuid NOT NULL REFERENCES expense_categories(id), description text NOT NULL,
  currency char(3) NOT NULL REFERENCES currencies(code), exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), amount_base numeric(20,4) NOT NULL DEFAULT 0,
  payment_mode text NOT NULL CHECK (payment_mode IN ('PAID_CASH','ACCRUED','PAID_BY_PARTNER')),
  cash_account_id uuid REFERENCES cash_accounts(id),
  partner_treatment text CHECK (partner_treatment IN ('PAYABLE_TO_PARTNER','OFFSET_AGAINST_ADVANCES')),
  settlement_note text,                                                      -- mandatory documentation for OFFSET_AGAINST_ADVANCES
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')),
  version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES users(id), posted_at timestamptz, journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL)),
  CHECK ((payment_mode = 'PAID_BY_PARTNER') = (partner_treatment IS NOT NULL)),                       -- exactly ONE treatment: never recorded twice
  CHECK (payment_mode <> 'PAID_CASH' OR cash_account_id IS NOT NULL),
  CHECK (partner_treatment IS DISTINCT FROM 'OFFSET_AGAINST_ADVANCES' OR length(coalesce(settlement_note, '')) >= 5)
);
CREATE UNIQUE INDEX ON expenses(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON expenses(company_id, draft_ref);
CREATE TABLE expense_payments (                 -- settles an ACCRUED expense (2210) or a partner payable (2300): never a new expense
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  expense_id uuid NOT NULL REFERENCES expenses(id), cash_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), amount_base numeric(20,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','POSTED','REVERSED')), version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES users(id), posted_at timestamptz, journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL))
);
CREATE UNIQUE INDEX ON expense_payments(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON expense_payments(company_id, draft_ref);

-- ---------------- payroll ----------------
CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL, job_title text, monthly_salary numeric(20,4) NOT NULL CHECK (monthly_salary >= 0),
  currency char(3) NOT NULL REFERENCES currencies(code), is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(), version int NOT NULL DEFAULT 1
);
CREATE TABLE payroll_accruals (                  -- the salary is an expense EVERY month, paid or not
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  period_month date NOT NULL CHECK (period_month = date_trunc('month', period_month)::date),
  currency char(3) NOT NULL REFERENCES currencies(code), exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), amount_base numeric(20,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','REVERSED')), version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES users(id), posted_at timestamptz, journal_entry_id uuid REFERENCES journal_entries(id)
);
CREATE UNIQUE INDEX payroll_one_active_per_month ON payroll_accruals(employee_id, period_month) WHERE status <> 'REVERSED';
CREATE TABLE payroll_payments (                  -- reduces the liability only; never an expense
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  accrual_id uuid NOT NULL REFERENCES payroll_accruals(id), cash_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  doc_no text, doc_date date NOT NULL, amount numeric(20,4) NOT NULL CHECK (amount > 0), amount_base numeric(20,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')), version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  journal_entry_id uuid REFERENCES journal_entries(id)
);
CREATE UNIQUE INDEX ON payroll_payments(company_id, doc_no) WHERE doc_no IS NOT NULL;

-- ---------------- capital (owner funds alone; withdrawal = request + owner approval) ----------------
CREATE TABLE capital_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('INJECTION','WITHDRAWAL')),
  partner_id uuid NOT NULL REFERENCES partners(id), cash_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  currency char(3) NOT NULL REFERENCES currencies(code), exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), amount_base numeric(20,4) NOT NULL DEFAULT 0, reason text NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id), approved_by uuid REFERENCES users(id), rejected_reason text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','REQUESTED','POSTED','REJECTED','REVERSED')), version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), posted_at timestamptz, journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL)),
  CHECK (status NOT IN ('POSTED','REVERSED') OR approved_by IS NOT NULL)
);
CREATE UNIQUE INDEX ON capital_transactions(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON capital_transactions(company_id, draft_ref);
CREATE FUNCTION assert_capital_rules() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.approved_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.approved_by AND is_owner) THEN RAISE EXCEPTION 'CAPITAL_APPROVAL_OWNER_ONLY'; END IF;
  IF NEW.approved_by IS NOT NULL AND NEW.approved_by = NEW.requested_by AND EXISTS (SELECT 1 FROM users WHERE id = NEW.requested_by AND NOT is_owner) THEN RAISE EXCEPTION 'CAPITAL_APPROVAL_OWNER_ONLY'; END IF;
  IF NEW.kind = 'INJECTION' AND NOT EXISTS (SELECT 1 FROM partners WHERE id = NEW.partner_id AND funds_capital) THEN RAISE EXCEPTION 'ONLY_OWNER_FUNDS_CAPITAL'; END IF;
  IF NEW.kind = 'WITHDRAWAL' AND NOT EXISTS (SELECT 1 FROM partners WHERE id = NEW.partner_id AND funds_capital) THEN RAISE EXCEPTION 'ONLY_OWNER_FUNDS_CAPITAL'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capital_rules BEFORE INSERT OR UPDATE ON capital_transactions FOR EACH ROW EXECUTE FUNCTION assert_capital_rules();

-- ---------------- personal draws & person-to-person debts (NOT operating expenses) ----------------
CREATE TABLE personal_advances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, doc_date date NOT NULL,
  partner_id uuid NOT NULL REFERENCES partners(id), kind text NOT NULL CHECK (kind IN ('DRAW','REPAYMENT')),
  cash_account_id uuid NOT NULL REFERENCES cash_accounts(id),
  currency char(3) NOT NULL REFERENCES currencies(code), exchange_rate_snapshot numeric(18,8) NOT NULL CHECK (exchange_rate_snapshot > 0),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), amount_base numeric(20,4) NOT NULL DEFAULT 0, note text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','REVERSED')), version int NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  posted_by uuid REFERENCES users(id), posted_at timestamptz, journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL))
);
CREATE UNIQUE INDEX ON personal_advances(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON personal_advances(company_id, draft_ref);
CREATE TABLE personal_debts (                   -- record-only: debts between individuals are outside the business books
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  person text NOT NULL, direction text NOT NULL CHECK (direction IN ('THEY_OWE_ME','I_OWE_THEM')), currency char(3) NOT NULL REFERENCES currencies(code),
  amount numeric(20,4) NOT NULL CHECK (amount > 0), paid numeric(20,4) NOT NULL DEFAULT 0 CHECK (paid >= 0), note text,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), CHECK (paid <= amount)
);

-- ---------------- opening balances ----------------
CREATE TABLE opening_balances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  as_of date NOT NULL, kind text NOT NULL CHECK (kind IN ('CAPITAL','CASH','INVENTORY_LAYER','CUSTOMER','SUPPLIER','RETAINED_EARNINGS')),
  cash_account_id uuid REFERENCES cash_accounts(id), contact_id uuid REFERENCES contacts(id), product_id uuid REFERENCES products(id), location_id uuid REFERENCES stock_locations(id),
  currency char(3) NOT NULL DEFAULT 'IQD' REFERENCES currencies(code), fx_rate numeric(18,8) NOT NULL DEFAULT 1,
  amount numeric(20,4) NOT NULL CHECK (amount > 0),                         -- document currency (for inventory: total layer cost in IQD)
  qty_base numeric(20,6), received_at date, note text,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED')),
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'CASH' OR cash_account_id IS NOT NULL), CHECK (kind NOT IN ('CUSTOMER','SUPPLIER') OR contact_id IS NOT NULL),
  CHECK (kind <> 'INVENTORY_LAYER' OR (product_id IS NOT NULL AND location_id IS NOT NULL AND qty_base > 0 AND received_at IS NOT NULL))
);

-- ---------------- profit settlements ----------------
CREATE TABLE profit_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  draft_ref text NOT NULL, doc_no text, period_start date NOT NULL, period_end date NOT NULL,
  eligible_profit numeric(20,4) NOT NULL DEFAULT 0,                        -- E: newly collection-eligible profit
  deductions numeric(20,4) NOT NULL DEFAULT 0,                             -- X: expenses & other P&L items accrued since the previous settlement
  deductions_cum numeric(20,4) NOT NULL DEFAULT 0,                         -- cumulative ledger deductions up to period_end (continuity)
  adjustments numeric(20,4) NOT NULL DEFAULT 0,                            -- A
  loss_carried_in numeric(20,4) NOT NULL DEFAULT 0 CHECK (loss_carried_in >= 0),
  reserved numeric(20,4) NOT NULL DEFAULT 0 CHECK (reserved >= 0), reserved_reason text,
  loss_covered numeric(20,4) NOT NULL DEFAULT 0 CHECK (loss_covered >= 0),
  loss_carried_out numeric(20,4) NOT NULL DEFAULT 0 CHECK (loss_carried_out >= 0),
  distributable numeric(20,4) NOT NULL DEFAULT 0 CHECK (distributable >= 0),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','REVERSED')), version int NOT NULL DEFAULT 1,
  approved_by uuid REFERENCES users(id), approved_at timestamptz, notes text,
  created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), journal_entry_id uuid REFERENCES journal_entries(id),
  CHECK (period_end >= period_start), CHECK (distributable = 0 OR loss_carried_out = 0),
  CHECK ((status IN ('POSTED','REVERSED')) = (doc_no IS NOT NULL)), CHECK (status NOT IN ('POSTED','REVERSED') OR approved_by IS NOT NULL)
);
CREATE UNIQUE INDEX ON profit_settlements(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX ON profit_settlements(company_id, draft_ref);
ALTER TABLE profit_settlements ADD CONSTRAINT no_overlapping_settlements
  EXCLUDE USING gist (company_id WITH =, daterange(period_start, period_end, '[]') WITH &&) WHERE (status = 'POSTED');
CREATE TABLE profit_settlement_shares (
  company_id uuid NOT NULL REFERENCES companies(id),
  settlement_id uuid NOT NULL REFERENCES profit_settlements(id), partner_id uuid NOT NULL REFERENCES partners(id),
  share_amount numeric(20,4) NOT NULL CHECK (share_amount >= 0), PRIMARY KEY (settlement_id, partner_id)
);
CREATE TABLE profit_settlement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  settlement_id uuid NOT NULL REFERENCES profit_settlements(id), invoice_id uuid NOT NULL REFERENCES sales_invoices(id),
  adjusted_profit numeric(20,4) NOT NULL, collected_ratio numeric(9,8) NOT NULL CHECK (collected_ratio BETWEEN 0 AND 1),
  linked_profit numeric(20,4) NOT NULL, released_before numeric(20,4) NOT NULL, newly_released numeric(20,4) NOT NULL, released_after numeric(20,4) NOT NULL,
  UNIQUE (settlement_id, invoice_id), CHECK (released_after = released_before + newly_released), CHECK (released_after <= linked_profit)
);
CREATE FUNCTION assert_release_continuity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cum numeric;
BEGIN
  SELECT coalesce(sum(l.newly_released), 0) INTO cum FROM profit_settlement_lines l JOIN profit_settlements s ON s.id = l.settlement_id
   WHERE l.invoice_id = NEW.invoice_id AND s.status = 'POSTED';
  IF NEW.released_before <> cum THEN RAISE EXCEPTION 'PROFIT_ALREADY_RELEASED invoice=% expected_before=% got=%', NEW.invoice_id, cum, NEW.released_before; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER release_continuity BEFORE INSERT ON profit_settlement_lines FOR EACH ROW EXECUTE FUNCTION assert_release_continuity();
CREATE TABLE profit_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  doc_no text, doc_date date NOT NULL,
  settlement_id uuid NOT NULL REFERENCES profit_settlements(id), partner_id uuid NOT NULL REFERENCES partners(id),
  amount numeric(20,4) NOT NULL CHECK (amount > 0),                                      -- share settled by this payout (cash + advances deducted)
  advances_deducted numeric(20,4) NOT NULL DEFAULT 0 CHECK (advances_deducted >= 0),
  cash_account_id uuid NOT NULL REFERENCES cash_accounts(id), idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','REVERSED')), version int NOT NULL DEFAULT 1,
  paid_by uuid NOT NULL REFERENCES users(id), paid_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  journal_entry_id uuid REFERENCES journal_entries(id),
  UNIQUE (company_id, idempotency_key), CHECK (advances_deducted <= amount)
);
CREATE UNIQUE INDEX ON profit_payouts(company_id, doc_no) WHERE doc_no IS NOT NULL;
CREATE FUNCTION assert_payout_within_share() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE share numeric; paid numeric;
BEGIN
  SELECT share_amount INTO share FROM profit_settlement_shares WHERE settlement_id = NEW.settlement_id AND partner_id = NEW.partner_id FOR UPDATE;
  IF share IS NULL THEN RAISE EXCEPTION 'NO_SHARE_FOR_PARTNER'; END IF;
  SELECT coalesce(sum(amount), 0) INTO paid FROM profit_payouts WHERE settlement_id = NEW.settlement_id AND partner_id = NEW.partner_id AND status = 'POSTED';
  IF paid + NEW.amount > share THEN RAISE EXCEPTION 'PAYOUT_EXCEEDS_SHARE share=% already_paid=% requested=%', share, paid, NEW.amount; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payout_within_share BEFORE INSERT ON profit_payouts FOR EACH ROW EXECUTE FUNCTION assert_payout_within_share();

-- ---------------- lifecycle guards (posted = immutable; only POSTED -> REVERSED) ----------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['expenses','expense_payments','payroll_accruals','payroll_payments','capital_transactions','personal_advances','profit_settlements','profit_payouts'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_document_lifecycle()', t || '_lifecycle', t);
  END LOOP;
END $$;
CREATE TRIGGER settlement_lines_immutable BEFORE UPDATE OR DELETE ON profit_settlement_lines FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER settlement_shares_immutable BEFORE UPDATE OR DELETE ON profit_settlement_shares FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------- RLS ----------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['partners','accounting_periods','expense_categories','expenses','expense_payments','employees','payroll_accruals','payroll_payments','capital_transactions',
    'personal_advances','personal_debts','opening_balances','profit_settlements','profit_settlement_shares','profit_settlement_lines','profit_payouts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid)$f$, t);
  END LOOP;
END $$;

-- ---------------- per-company finance seed (idempotent) ----------------
CREATE FUNCTION seed_company_finance(p_company uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a record; c record;
BEGIN
  INSERT INTO partners(company_id, name, kind, funds_capital, user_id)
    SELECT p_company, u.display_name, 'OWNER', true, u.id FROM users u WHERE u.company_id = p_company AND u.is_owner ON CONFLICT (company_id, kind) DO NOTHING;
  INSERT INTO partners(company_id, name, kind, funds_capital) VALUES (p_company, 'الشريك', 'PARTNER', false) ON CONFLICT (company_id, kind) DO NOTHING;
  FOR a IN SELECT * FROM (VALUES ('6300','إيجارات'),('6400','كهرباء وماء ووقود'),('6500','اتصالات وإنترنت'),('6600','صيانة'),('6700','تسويق ودعاية'),('6800','ضيافة ومتفرقات')) v(code,name) LOOP
    INSERT INTO accounts(company_id, code, name, type, normal_side, is_system) VALUES (p_company, a.code, a.name, 'EXPENSE', 'DEBIT', true) ON CONFLICT (company_id, code) DO NOTHING;
  END LOOP;
  FOR c IN SELECT * FROM (VALUES ('نقل','VARIABLE','DIRECT','6100'),('رواتب وأجور','FIXED','GENERAL','6200'),('إيجارات','FIXED','GENERAL','6300'),('كهرباء وماء ووقود','VARIABLE','GENERAL','6400'),
      ('اتصالات وإنترنت','FIXED','GENERAL','6500'),('صيانة','VARIABLE','GENERAL','6600'),('تسويق ودعاية','VARIABLE','GENERAL','6700'),('ضيافة ومتفرقات','VARIABLE','GENERAL','6800'),('مصروفات عامة','VARIABLE','GENERAL','6900')) v(n,nature,scope,code) LOOP
    INSERT INTO expense_categories(company_id, name, nature, scope, account_id) SELECT p_company, c.n, c.nature, c.scope, ac.id FROM accounts ac WHERE ac.company_id = p_company AND ac.code = c.code ON CONFLICT (company_id, name) DO NOTHING;
  END LOOP;
  INSERT INTO document_sequences(company_id, doc_type, fiscal_year, prefix)
    SELECT p_company, v.t, extract(year from now())::int, v.p FROM (VALUES ('expense','EX'),('expense_payment','EP'),('payroll_payment','PP'),('capital','CP'),('personal_advance','PA'),('profit_settlement','PS'),('profit_payout','PY')) v(t,p) ON CONFLICT DO NOTHING;
END $$;
DO $$ DECLARE c record; BEGIN FOR c IN SELECT id FROM companies LOOP PERFORM seed_company_finance(c.id); END LOOP; END $$;
