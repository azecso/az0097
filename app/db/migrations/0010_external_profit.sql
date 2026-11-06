-- Phase 9: profit that was already distributed OUTSIDE the system when an invoice is collected.
-- It is stored as an extra allocation row flagged `external` (so every "paid / outstanding" sum already counts it) and is posted
-- Dr 3500 (split 50/50 between the two partners) / Cr 1200 — no cash moves. Profit settlements exclude it from what can be distributed again.
ALTER TABLE receipt_allocations ADD COLUMN external boolean NOT NULL DEFAULT false, ADD COLUMN note text;
ALTER TABLE receipt_allocations DROP CONSTRAINT receipt_allocations_receipt_id_invoice_id_key;
ALTER TABLE receipt_allocations ADD CONSTRAINT receipt_allocations_receipt_invoice_ext_key UNIQUE (receipt_id, invoice_id, external);
INSERT INTO accounts(company_id, code, name, type, normal_side, is_system)
  SELECT id, '3500', 'أرباح موزَّعة خارج النظام', 'EQUITY', 'DEBIT', true FROM companies ON CONFLICT DO NOTHING;
