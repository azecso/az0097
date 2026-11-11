-- A partner holding US dollars needs a USD custody account (restricted money, like the dinar one). Existing companies get it; new ones through the seed function.
INSERT INTO accounts(company_id, code, name, type, normal_side, is_system)
  SELECT id, '1151', 'عهدة نقدية — الشريك USD', 'ASSET', 'DEBIT', true FROM companies ON CONFLICT (company_id, code) DO NOTHING;
INSERT INTO cash_accounts(company_id, account_id, name, currency, kind, counts_toward_available_cash)
  SELECT a.company_id, a.id, 'عهدة نقدية — الشريك USD', 'USD', 'PARTNER_CUSTODY', false FROM accounts a WHERE a.code = '1151' ON CONFLICT (company_id, account_id) DO NOTHING;
CREATE OR REPLACE FUNCTION seed_company_operational(p_company uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE w_main uuid; w_part uuid; a record;
BEGIN
  INSERT INTO warehouses(company_id, name, kind) VALUES (p_company, 'المخزن الرئيسي', 'MAIN') ON CONFLICT (company_id, kind) DO NOTHING;
  INSERT INTO warehouses(company_id, name, kind) VALUES (p_company, 'عهدة الشريك', 'PARTNER_CUSTODY') ON CONFLICT (company_id, kind) DO NOTHING;
  SELECT id INTO w_main FROM warehouses WHERE company_id = p_company AND kind = 'MAIN';
  SELECT id INTO w_part FROM warehouses WHERE company_id = p_company AND kind = 'PARTNER_CUSTODY';
  INSERT INTO stock_locations(company_id, warehouse_id, name) VALUES (p_company, w_main, 'الرئيسي') ON CONFLICT DO NOTHING;
  INSERT INTO stock_locations(company_id, warehouse_id, name) VALUES (p_company, w_part, 'عهدة الشريك') ON CONFLICT DO NOTHING;
  FOR a IN SELECT * FROM (VALUES ('1110','الصندوق الرئيسي IQD','IQD','MAIN_CASH',true), ('1120','الصندوق الرئيسي USD','USD','MAIN_CASH',true),
                                 ('1150','عهدة نقدية — الشريك','IQD','PARTNER_CUSTODY',false), ('1151','عهدة نقدية — الشريك USD','USD','PARTNER_CUSTODY',false)) v(code,name,cur,kind,cnt) LOOP
    INSERT INTO cash_accounts(company_id, account_id, name, currency, kind, counts_toward_available_cash)
      SELECT p_company, ac.id, a.name, a.cur, a.kind, a.cnt FROM accounts ac WHERE ac.company_id = p_company AND ac.code = a.code
      ON CONFLICT (company_id, account_id) DO NOTHING;
  END LOOP;
  INSERT INTO document_sequences(company_id, doc_type, fiscal_year, prefix)
    SELECT p_company, v.t, extract(year from now())::int, v.p FROM (VALUES ('stock_transfer','ST'),('inventory_count','IC')) v(t,p)
    ON CONFLICT DO NOTHING;
END $$;
