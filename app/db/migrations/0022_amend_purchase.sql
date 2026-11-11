-- Round 3: editing a POSTED purchase invoice keeps its NUMBER, like sales invoices (0011): the old record is reversed (stock layers retired, ledger undone — the journal
-- stays append-only), renamed "<no>~rN" and hidden, a new record carrying the ORIGINAL number is created and posted. `amended_from` links them for the audit trail.
ALTER TABLE purchase_orders ADD COLUMN amended_from uuid REFERENCES purchase_orders(id);
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'purchase_orders'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%doc_no IS NOT NULL%' AND pg_get_constraintdef(oid) ILIKE '%POSTED%'
  LOOP EXECUTE format('ALTER TABLE purchase_orders DROP CONSTRAINT %I', c.conname); END LOOP;
END $$;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_posted_has_number CHECK (status NOT IN ('POSTED','REVERSED') OR doc_no IS NOT NULL);   -- a DRAFT may carry the number of the invoice it amends

CREATE OR REPLACE FUNCTION guard_document_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o jsonb; n jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'ONLY_DRAFT_CAN_BE_DELETED %', TG_TABLE_NAME; END IF;
    RETURN OLD;
  END IF;
  IF current_setting('app.amend', true) = 'on' THEN
    -- amendment of an invoice: ONLY the number of an already-reversed record may change
    IF TG_TABLE_NAME IN ('sales_invoices','purchase_orders') AND OLD.status = 'REVERSED' AND (to_jsonb(OLD) - 'doc_no' - 'updated_at') = (to_jsonb(NEW) - 'doc_no' - 'updated_at') THEN RETURN NEW; END IF;
    -- in-place amendment: POSTED -> DRAFT keeping the number
    IF TG_TABLE_NAME IN ('customer_receipts','supplier_payments','expenses') AND OLD.status = 'POSTED' AND NEW.status = 'DRAFT' AND OLD.doc_no IS NOT DISTINCT FROM NEW.doc_no THEN RETURN NEW; END IF;
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
