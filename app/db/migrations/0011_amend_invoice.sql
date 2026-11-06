-- Phase 9b: editing a POSTED sales invoice keeps its NUMBER. The old record is reversed (stock, COGS, ledger all undone — the ledger itself stays append-only),
-- renamed "<no>~rN" and hidden from lists; a new record is created and posted with the ORIGINAL number. `amended_from` links them for the audit trail.
ALTER TABLE sales_invoices ADD COLUMN amended_from uuid REFERENCES sales_invoices(id);
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'sales_invoices'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%doc_no IS NOT NULL%' AND pg_get_constraintdef(oid) ILIKE '%POSTED%'
  LOOP EXECUTE format('ALTER TABLE sales_invoices DROP CONSTRAINT %I', c.conname); END LOOP;
END $$;
ALTER TABLE sales_invoices ADD CONSTRAINT sales_invoices_posted_has_number CHECK (status NOT IN ('POSTED','REVERSED') OR doc_no IS NOT NULL);   -- a DRAFT may already carry the number of the invoice it amends

CREATE OR REPLACE FUNCTION guard_document_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o jsonb; n jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'ONLY_DRAFT_CAN_BE_DELETED %', TG_TABLE_NAME; END IF;
    RETURN OLD;
  END IF;
  -- amendment of a sales invoice: ONLY the number of an already-reversed record may change (and only inside the amend transaction)
  IF TG_TABLE_NAME = 'sales_invoices' AND OLD.status = 'REVERSED' AND current_setting('app.amend', true) = 'on'
     AND (to_jsonb(OLD) - 'doc_no' - 'updated_at') = (to_jsonb(NEW) - 'doc_no' - 'updated_at') THEN RETURN NEW; END IF;
  IF OLD.status = 'POSTED' THEN
    IF NEW.status = 'REVERSED' THEN
      o := to_jsonb(OLD) - 'status' - 'updated_at' - 'version'; n := to_jsonb(NEW) - 'status' - 'updated_at' - 'version';
      IF o <> n THEN RAISE EXCEPTION 'POSTED_DOCUMENT_IMMUTABLE %', TG_TABLE_NAME; END IF;
    ELSE RAISE EXCEPTION 'POSTED_DOCUMENT_IMMUTABLE %', TG_TABLE_NAME; END IF;
  ELSIF OLD.status = 'REVERSED' THEN RAISE EXCEPTION 'REVERSED_DOCUMENT_IMMUTABLE %', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
