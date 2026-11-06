-- Phase 9c: a posted customer receipt / supplier payment / expense can be edited IN PLACE with its number kept: inside an "amend" transaction the document is
-- un-posted (its journal entry and cash movement are reversed — the ledger stays append-only), edited as a draft, and posted again with the same number.
DO $$ DECLARE t text; c record; BEGIN
  FOREACH t IN ARRAY ARRAY['customer_receipts','supplier_payments','expenses'] LOOP
    FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = t::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%doc_no IS NOT NULL%' AND pg_get_constraintdef(oid) ILIKE '%POSTED%'
    LOOP EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c.conname); END LOOP;
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (status NOT IN (''POSTED'',''REVERSED'') OR doc_no IS NOT NULL)', t, t || '_posted_has_number');
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION guard_document_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o jsonb; n jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'ONLY_DRAFT_CAN_BE_DELETED %', TG_TABLE_NAME; END IF;
    RETURN OLD;
  END IF;
  IF current_setting('app.amend', true) = 'on' THEN
    -- amendment of a sales invoice: ONLY the number of an already-reversed record may change
    IF TG_TABLE_NAME = 'sales_invoices' AND OLD.status = 'REVERSED' AND (to_jsonb(OLD) - 'doc_no' - 'updated_at') = (to_jsonb(NEW) - 'doc_no' - 'updated_at') THEN RETURN NEW; END IF;
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
