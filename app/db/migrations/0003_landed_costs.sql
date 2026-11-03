-- Landed costs: freight/loading/customs charges on a purchase, each either CAPITALISED into the inventory
-- cost of that purchase's layers (allocated pro-rata to goods value) or EXPENSED (transport 6100 / other 6900).
CREATE TABLE purchase_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  purchase_id uuid NOT NULL REFERENCES purchase_orders(id), line_no int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('TRANSPORT','LOADING','CUSTOMS','OTHER')),
  description text, amount numeric(20,4) NOT NULL CHECK (amount > 0),
  capitalize boolean NOT NULL,
  amount_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (amount_base >= 0),
  UNIQUE (purchase_id, line_no)
);
ALTER TABLE purchase_lines ADD COLUMN landed_cost_base numeric(20,4) NOT NULL DEFAULT 0 CHECK (landed_cost_base >= 0);
CREATE TRIGGER purchase_charges_guard BEFORE UPDATE OR DELETE ON purchase_charges
  FOR EACH ROW EXECUTE FUNCTION guard_line_parent('purchase_orders','purchase_id');
ALTER TABLE purchase_charges ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON purchase_charges
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
