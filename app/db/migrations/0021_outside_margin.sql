-- "الربح خارج التوزيع" (price-variable goods): the company cash box gets the COST back, the margin above cost is received OUTSIDE the cash box.
-- The margin is real trade profit (it stays in sales/COGS/profit reports) but it is NOT partnership profit and creates NO partner share.
-- It is booked as Dr 3600 / Cr 1200 (a non-cash settlement of the receivable that left the company's hands) — not an expense, not a capital reduction, not partner profit (3500).
INSERT INTO accounts(company_id, code, name, type, normal_side, is_system)
  SELECT id, '3600', 'فرق ربح مستلم خارج الصندوق (خارج الشراكة)', 'EQUITY', 'DEBIT', true FROM companies ON CONFLICT (company_id, code) DO NOTHING;
ALTER TABLE receipt_allocations ADD COLUMN external_kind text NOT NULL DEFAULT 'PROFIT_SHARE' CHECK (external_kind IN ('PROFIT_SHARE','OUTSIDE_MARGIN'));
ALTER TABLE receipt_allocations DROP CONSTRAINT receipt_allocations_receipt_invoice_ext_key;
ALTER TABLE receipt_allocations ADD CONSTRAINT receipt_allocations_receipt_invoice_ext_key UNIQUE (receipt_id, invoice_id, external, external_kind);
-- a receipt may carry only outside-margin (customer paid everything outside the box): cash amount 0 is then allowed for that receipt
ALTER TABLE customer_receipts DROP CONSTRAINT IF EXISTS customer_receipts_amount_check;
ALTER TABLE customer_receipts ADD CONSTRAINT customer_receipts_amount_check CHECK (amount >= 0);
