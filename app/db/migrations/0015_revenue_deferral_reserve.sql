-- (1) Revenue is recognised at DELIVERY (transfer of control). Invoices created after this migration with delivery_mode = SEPARATE book their value
--     to 2600 (deferred revenue) and each delivery moves the delivered share to 4100/4150. WITH_INVOICE invoices deliver in the same transaction and are unchanged.
--     Invoices posted before this migration are NOT rewritten (history stays); profit eligibility is computed from delivered quantities for every invoice.
-- (2) Profit reserve: the part of distributable profit the owner holds back is a documented balance that later settlements may release.
INSERT INTO accounts(company_id, code, name, type, normal_side, is_system)
  SELECT id, '2600', 'إيرادات مؤجلة — فواتير غير مسلّمة', 'LIABILITY', 'CREDIT', true FROM companies ON CONFLICT (company_id, code) DO NOTHING;
ALTER TABLE sales_invoices ADD COLUMN revenue_deferred boolean NOT NULL DEFAULT false;
ALTER TABLE delivery_lines ADD COLUMN revenue_net_base numeric(20,4) NOT NULL DEFAULT 0, ADD COLUMN revenue_gross_base numeric(20,4) NOT NULL DEFAULT 0;
ALTER TABLE profit_settlements ADD COLUMN reserve_released numeric(20,4) NOT NULL DEFAULT 0 CHECK (reserve_released >= 0), ADD COLUMN reserve_release_reason text;
