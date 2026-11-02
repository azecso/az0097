-- Phase 0 executable spec: proves DB-level accounting invariants + the SRS §11 FIFO/profit numbers.
-- Run:  psql -v ON_ERROR_STOP=1 -f schema.sql ; psql -v ON_ERROR_STOP=1 -f tests/ledger_invariants.sql
-- Everything runs in one transaction and is rolled back at the end.
BEGIN;

CREATE TEMP TABLE results(id text, name text, ok boolean, detail text);

CREATE FUNCTION pg_temp.expect_error(p_id text, p_name text, p_sql text, p_pattern text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  SET CONSTRAINTS ALL IMMEDIATE;
  BEGIN
    EXECUTE p_sql;
    INSERT INTO results VALUES (p_id, p_name, false, 'no error raised');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO results VALUES (p_id, p_name, SQLERRM ~ p_pattern, left(SQLERRM, 90));
  END;
  SET CONSTRAINTS ALL DEFERRED;
END $$;

CREATE FUNCTION pg_temp.check_eq(p_id text, p_name text, p_actual numeric, p_expected numeric) RETURNS void
LANGUAGE sql AS $$ INSERT INTO results VALUES (p_id, p_name, p_actual = p_expected, p_actual || ' vs ' || p_expected) $$;

-- ---------- fixtures ----------
INSERT INTO currencies VALUES ('IQD','Iraqi dinar',0),('USD','US dollar',2);
INSERT INTO companies(id,name) VALUES ('00000000-0000-0000-0000-000000000001','Test Co');
INSERT INTO users(id,company_id,username,display_name,password_hash,is_owner) VALUES
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000001','owner','Owner','x',true),
 ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000001','acct','Accountant','x',false);
INSERT INTO partners(id,company_id,name,kind,share_percent,funds_capital,user_id) VALUES
 ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000001','Owner','OWNER',50,true,'00000000-0000-0000-0000-0000000000a1'),
 ('00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-000000000001','Partner','PARTNER',50,false,NULL);
INSERT INTO accounts(id,company_id,code,name,type,normal_side) VALUES
 ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-000000000001','1110','Cash','ASSET','DEBIT'),
 ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-000000000001','3100','Capital','EQUITY','CREDIT');
INSERT INTO cash_accounts(id,company_id,account_id,name,currency,kind) VALUES
 ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000c1','Main','IQD','MAIN_CASH');

-- ---------- J: journal ----------
-- J-1 balanced entry accepted
INSERT INTO journal_entries(id,company_id,entry_no,entry_date,source_doc_type,source_doc_id,posted_by) VALUES
 ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-000000000001','JE-1',current_date,'capital',gen_random_uuid(),'00000000-0000-0000-0000-0000000000a1');
INSERT INTO journal_lines(company_id,entry_id,line_no,account_id,debit_base,credit_base,currency,amount_orig,fx_rate_snapshot) VALUES
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1',1,'00000000-0000-0000-0000-0000000000c1',10000000,0,'IQD',10000000,1),
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1',2,'00000000-0000-0000-0000-0000000000c2',0,10000000,'IQD',10000000,1);
SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
INSERT INTO results VALUES ('J-1','balanced capital entry 10,000,000 accepted',true,'ok');

-- J-2 unbalanced entry rejected
INSERT INTO journal_entries(id,company_id,entry_no,entry_date,source_doc_type,source_doc_id,posted_by) VALUES
 ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-000000000001','JE-2',current_date,'x',gen_random_uuid(),'00000000-0000-0000-0000-0000000000a1');
SELECT pg_temp.expect_error('J-2','unbalanced entry rejected',
 $q$INSERT INTO journal_lines(company_id,entry_id,line_no,account_id,debit_base,credit_base,currency,amount_orig,fx_rate_snapshot)
    VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e2',1,'00000000-0000-0000-0000-0000000000c1',100,0,'IQD',100,1)$q$,
 'UNBALANCED_ENTRY|ENTRY_NEEDS_TWO_LINES');
-- J-3 a line cannot be both debit and credit
SELECT pg_temp.expect_error('J-3','line with debit AND credit rejected',
 $q$INSERT INTO journal_lines(company_id,entry_id,line_no,account_id,debit_base,credit_base,currency,amount_orig,fx_rate_snapshot)
    VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000e1',9,'00000000-0000-0000-0000-0000000000c1',5,5,'IQD',5,1)$q$,
 'journal_lines_check');
-- J-4/J-5 journal immutable
SELECT pg_temp.expect_error('J-4','journal line update rejected',
 $q$UPDATE journal_lines SET debit_base = 1 WHERE entry_id='00000000-0000-0000-0000-0000000000e1' AND line_no=1$q$,'IMMUTABLE_TABLE');
SELECT pg_temp.expect_error('J-5','journal entry delete rejected',
 $q$DELETE FROM journal_entries WHERE id='00000000-0000-0000-0000-0000000000e1'$q$,'IMMUTABLE_TABLE');
DELETE FROM journal_entries WHERE false;  -- no-op keeps the transaction clean

-- ---------- F: FIFO executable spec (SRS §11 case 1) ----------
INSERT INTO products(id,company_id,code,name,base_uom) VALUES
 ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-000000000001','P1','Item','piece');
INSERT INTO warehouses(id,company_id,name,kind) VALUES
 ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-000000000001','Main','MAIN'),
 ('00000000-0000-0000-0000-0000000000f3','00000000-0000-0000-0000-000000000001','Partner','PARTNER_CUSTODY');
INSERT INTO stock_locations(id,company_id,warehouse_id,name) VALUES
 ('00000000-0000-0000-0000-0000000000f4','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f2','main'),
 ('00000000-0000-0000-0000-0000000000f5','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f3','partner');
INSERT INTO stock_lots(company_id,product_id,location_id,origin_doc_type,origin_doc_id,received_at,qty_received,qty_remaining,unit_cost_base,unit_cost_orig,currency,fx_rate_snapshot) VALUES
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000f4','purchase',gen_random_uuid(),'2026-01-01',100,100,10000,10000,'IQD',1),
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000f4','purchase',gen_random_uuid(),'2026-02-01',100,100,12000,12000,'IQD',1);

-- reference FIFO consumer (spec only; production version lives in packages/domain + SQL)
CREATE FUNCTION pg_temp.fifo_consume(p_product uuid, p_loc uuid, p_qty numeric) RETURNS numeric
LANGUAGE plpgsql AS $$
DECLARE l record; need numeric := p_qty; take numeric; cogs numeric := 0;
BEGIN
  FOR l IN SELECT * FROM stock_lots WHERE product_id=p_product AND location_id=p_loc AND qty_remaining>0
           ORDER BY received_at, id FOR UPDATE
  LOOP
    EXIT WHEN need = 0;
    take := LEAST(l.qty_remaining, need);
    UPDATE stock_lots SET qty_remaining = qty_remaining - take WHERE id = l.id;
    cogs := cogs + take * l.unit_cost_base; need := need - take;
  END LOOP;
  IF need > 0 THEN RAISE EXCEPTION 'INSUFFICIENT_STOCK missing=%', need; END IF;
  RETURN cogs;
END $$;

SELECT pg_temp.check_eq('F-1','FIFO sell 150 => COGS 1,600,000',
  pg_temp.fifo_consume('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000f4',150), 1600000);
SELECT pg_temp.check_eq('F-2','remaining 50 x 12,000 = 600,000',
  (SELECT sum(qty_remaining*unit_cost_base) FROM stock_lots WHERE location_id='00000000-0000-0000-0000-0000000000f4'), 600000);
SELECT pg_temp.expect_error('F-3','selling more than stock is rejected',
  $q$SELECT pg_temp.fifo_consume('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000f4',51)$q$,'INSUFFICIENT_STOCK');
SELECT pg_temp.expect_error('F-4','negative qty_remaining blocked by CHECK',
  $q$UPDATE stock_lots SET qty_remaining = -1$q$,'stock_lots_qty_remaining_check');

-- ---------- D: document lifecycle ----------
INSERT INTO contacts(id,company_id,kind,code,name) VALUES
 ('00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-000000000001','CUSTOMER','C1','Customer');
INSERT INTO sales_invoices(id,company_id,draft_ref,doc_date,customer_id,sale_type,currency,exchange_rate_snapshot,gross,net,net_base,cogs_base,created_by)
 VALUES ('00000000-0000-0000-0000-0000000000ab','00000000-0000-0000-0000-000000000001','D1',current_date,'00000000-0000-0000-0000-0000000000aa','CREDIT','IQD',1,1000000,1000000,1000000,700000,'00000000-0000-0000-0000-0000000000a2');
UPDATE sales_invoices SET doc_no='INV-2026-000001', status='POSTED', posted_by='00000000-0000-0000-0000-0000000000a1', posted_at=now() WHERE id='00000000-0000-0000-0000-0000000000ab';
SELECT pg_temp.expect_error('D-1','edit of POSTED invoice rejected',
  $q$UPDATE sales_invoices SET net = 1 WHERE id='00000000-0000-0000-0000-0000000000ab'$q$,'POSTED_DOCUMENT_IMMUTABLE');
SELECT pg_temp.expect_error('D-2','delete of POSTED invoice rejected',
  $q$DELETE FROM sales_invoices WHERE id='00000000-0000-0000-0000-0000000000ab'$q$,'ONLY_DRAFT_CAN_BE_DELETED');
SELECT pg_temp.expect_error('D-3','POSTED without doc_no rejected',
  $q$INSERT INTO sales_invoices(company_id,draft_ref,doc_date,customer_id,sale_type,currency,exchange_rate_snapshot,status,created_by)
     VALUES ('00000000-0000-0000-0000-000000000001','D2',current_date,'00000000-0000-0000-0000-0000000000aa','CASH','IQD',1,'POSTED','00000000-0000-0000-0000-0000000000a2')$q$,'sales_invoices_check');
SELECT pg_temp.expect_error('D-4','duplicate doc_no rejected',
  $q$INSERT INTO sales_invoices(company_id,draft_ref,doc_no,doc_date,customer_id,sale_type,currency,exchange_rate_snapshot,status,created_by)
     VALUES ('00000000-0000-0000-0000-000000000001','D3','INV-2026-000001',current_date,'00000000-0000-0000-0000-0000000000aa','CASH','IQD',1,'POSTED','00000000-0000-0000-0000-0000000000a2')$q$,'duplicate key');
UPDATE sales_invoices SET status='REVERSED' WHERE id='00000000-0000-0000-0000-0000000000ab';  -- reversal marker allowed
INSERT INTO results VALUES ('D-5','POSTED -> REVERSED transition allowed',true,'ok');

-- ---------- E: expenses / payroll ----------
SELECT pg_temp.expect_error('E-1','partner-paid expense must declare one treatment',
  $q$INSERT INTO expense_categories(id,company_id,name,nature,scope,account_id) VALUES ('00000000-0000-0000-0000-0000000000ac','00000000-0000-0000-0000-000000000001','n','FIXED','GENERAL','00000000-0000-0000-0000-0000000000c1');
     INSERT INTO expenses(company_id,draft_ref,doc_date,category_id,amount,currency,exchange_rate_snapshot,amount_base,payment_mode,created_by)
     VALUES ('00000000-0000-0000-0000-000000000001','E1',current_date,'00000000-0000-0000-0000-0000000000ac',50000,'IQD',1,50000,'PAID_BY_PARTNER','00000000-0000-0000-0000-0000000000a2')$q$,'expenses_check');
INSERT INTO employees(id,company_id,name,monthly_salary,currency) VALUES ('00000000-0000-0000-0000-0000000000ad','00000000-0000-0000-0000-000000000001','Emp',400000,'IQD');
INSERT INTO payroll_accruals(company_id,employee_id,period_month,amount,created_by) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000ad','2026-11-01',400000,'00000000-0000-0000-0000-0000000000a2');
SELECT pg_temp.expect_error('E-2','second accrual same employee/month rejected',
  $q$INSERT INTO payroll_accruals(company_id,employee_id,period_month,amount,created_by) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000ad','2026-11-01',400000,'00000000-0000-0000-0000-0000000000a2')$q$,'duplicate key');

-- ---------- C: capital permissions ----------
SELECT pg_temp.expect_error('C-1','accountant cannot approve capital',
  $q$INSERT INTO capital_transactions(company_id,doc_date,kind,partner_id,cash_account_id,amount,currency,exchange_rate_snapshot,amount_base,requested_by,approved_by,status)
     VALUES ('00000000-0000-0000-0000-000000000001',current_date,'WITHDRAWAL','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000d1',1000,'IQD',1,1000,'00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a2','APPROVED')$q$,'approved_by|CAPITAL_APPROVAL_OWNER_ONLY');
SELECT pg_temp.expect_error('C-2','requester cannot approve own request',
  $q$INSERT INTO capital_transactions(company_id,doc_date,kind,partner_id,cash_account_id,amount,currency,exchange_rate_snapshot,amount_base,requested_by,approved_by,status)
     VALUES ('00000000-0000-0000-0000-000000000001',current_date,'WITHDRAWAL','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000d1',1000,'IQD',1,1000,'00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a1','APPROVED')$q$,'capital_transactions_check');
SELECT pg_temp.expect_error('C-3','capital injection by non-funding partner rejected',
  $q$INSERT INTO capital_transactions(company_id,doc_date,kind,partner_id,cash_account_id,amount,currency,exchange_rate_snapshot,amount_base,requested_by)
     VALUES ('00000000-0000-0000-0000-000000000001',current_date,'INJECTION','00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000d1',1000,'IQD',1,1000,'00000000-0000-0000-0000-0000000000a2')$q$,'ONLY_OWNER_FUNDS_CAPITAL');
SELECT pg_temp.expect_error('C-4','no self-grant of permissions',
  $q$INSERT INTO permissions(id,resource,action) VALUES ('00000000-0000-0000-0000-0000000000ae','capital','approve');
     INSERT INTO user_permissions(user_id,permission_id,granted_by) VALUES ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000ae','00000000-0000-0000-0000-0000000000a2')$q$,'user_permissions_check');

-- ---------- P: profit settlement ----------
-- invoice 1,000,000 / cost 700,000 / collected 500,000 => linked profit 150,000 (SRS §11 case 3)
SELECT pg_temp.check_eq('P-1','collection-linked profit = 300,000 x 500k/1,000k = 150,000', 300000 * (500000.0/1000000.0), 150000);

INSERT INTO profit_settlements(id,company_id,period_start,period_end,eligible_profit,accrued_expenses,loss_carried_in,loss_covered,loss_carried_out,distributable,created_by)
 VALUES ('00000000-0000-0000-0000-0000000000b9','00000000-0000-0000-0000-000000000001','2026-11-01','2026-11-30',150000,0,0,0,0,150000,'00000000-0000-0000-0000-0000000000a2');
-- first settlement line OK (invoice is REVERSED in fixture above; use a fresh invoice id for FK)
INSERT INTO sales_invoices(id,company_id,draft_ref,doc_no,doc_date,customer_id,sale_type,currency,exchange_rate_snapshot,status,created_by)
 VALUES ('00000000-0000-0000-0000-0000000000b8','00000000-0000-0000-0000-000000000001','D9','INV-2026-000009',current_date,'00000000-0000-0000-0000-0000000000aa','CREDIT','IQD',1,'POSTED','00000000-0000-0000-0000-0000000000a2');
INSERT INTO profit_settlement_lines(settlement_id,invoice_id,adjusted_profit,collected_ratio,linked_profit,released_before,newly_released,released_after)
 VALUES ('00000000-0000-0000-0000-0000000000b9','00000000-0000-0000-0000-0000000000b8',300000,0.5,150000,0,150000,150000);
INSERT INTO results VALUES ('P-2','first release of invoice profit accepted',true,'ok');
UPDATE profit_settlements SET status='APPROVED', approved_by='00000000-0000-0000-0000-0000000000a1', approved_at=now() WHERE id='00000000-0000-0000-0000-0000000000b9';
INSERT INTO profit_settlement_shares VALUES
 ('00000000-0000-0000-0000-0000000000b9','00000000-0000-0000-0000-0000000000b1',75000),
 ('00000000-0000-0000-0000-0000000000b9','00000000-0000-0000-0000-0000000000b2',75000);

-- second settlement tries to release the same profit again (released_before=0 although 150,000 already released)
INSERT INTO profit_settlements(id,company_id,period_start,period_end,eligible_profit,accrued_expenses,loss_carried_in,loss_covered,loss_carried_out,distributable,created_by)
 VALUES ('00000000-0000-0000-0000-0000000000ba','00000000-0000-0000-0000-000000000001','2026-12-01','2026-12-31',150000,0,0,0,0,150000,'00000000-0000-0000-0000-0000000000a2');
SELECT pg_temp.expect_error('P-3','re-releasing the same invoice profit rejected',
  $q$INSERT INTO profit_settlement_lines(settlement_id,invoice_id,adjusted_profit,collected_ratio,linked_profit,released_before,newly_released,released_after)
     VALUES ('00000000-0000-0000-0000-0000000000ba','00000000-0000-0000-0000-0000000000b8',300000,0.5,150000,0,150000,150000)$q$,'PROFIT_ALREADY_RELEASED');
SELECT pg_temp.expect_error('P-4','release above collection-linked cap rejected',
  $q$INSERT INTO profit_settlement_lines(settlement_id,invoice_id,adjusted_profit,collected_ratio,linked_profit,released_before,newly_released,released_after)
     VALUES ('00000000-0000-0000-0000-0000000000ba','00000000-0000-0000-0000-0000000000b8',300000,0.5,150000,150000,50000,200000)$q$,'profit_settlement_lines_check');
SELECT pg_temp.expect_error('P-5','overlapping approved settlement period rejected',
  $q$UPDATE profit_settlements SET period_start='2026-11-15', period_end='2026-12-15', status='APPROVED', approved_by='00000000-0000-0000-0000-0000000000a1' WHERE id='00000000-0000-0000-0000-0000000000ba'$q$,'no_overlapping_settlements');

-- payouts: partial, then duplicate idempotency key, then over-share
INSERT INTO profit_payouts(company_id,settlement_id,partner_id,amount,cash_account_id,idempotency_key,paid_by)
 VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b9','00000000-0000-0000-0000-0000000000b2',50000,'00000000-0000-0000-0000-0000000000d1','PAY-1','00000000-0000-0000-0000-0000000000a1');
INSERT INTO results VALUES ('P-6','partial payout 50,000 of 75,000 accepted',true,'ok');
SELECT pg_temp.expect_error('P-7','replayed payout (same idempotency key) rejected',
  $q$INSERT INTO profit_payouts(company_id,settlement_id,partner_id,amount,cash_account_id,idempotency_key,paid_by)
     VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b9','00000000-0000-0000-0000-0000000000b2',20000,'00000000-0000-0000-0000-0000000000d1','PAY-1','00000000-0000-0000-0000-0000000000a1')$q$,'duplicate key');
SELECT pg_temp.expect_error('P-8','payout beyond remaining share (30,000 > 25,000) rejected',
  $q$INSERT INTO profit_payouts(company_id,settlement_id,partner_id,amount,cash_account_id,idempotency_key,paid_by)
     VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b9','00000000-0000-0000-0000-0000000000b2',30000,'00000000-0000-0000-0000-0000000000d1','PAY-2','00000000-0000-0000-0000-0000000000a1')$q$,'PAYOUT_EXCEEDS_SHARE');

-- ---------- S: sync idempotency ----------
INSERT INTO sync_operations(company_id,operation_id,idempotency_key,device_id,user_id,entity_type,entity_local_id,op,payload,client_created_at)
 VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f9','K1','dev1','00000000-0000-0000-0000-0000000000a2','sales_invoice',gen_random_uuid(),'CREATE_DRAFT','{}',now());
SELECT pg_temp.expect_error('S-1','replayed operation_id rejected (idempotent)',
  $q$INSERT INTO sync_operations(company_id,operation_id,idempotency_key,device_id,user_id,entity_type,entity_local_id,op,payload,client_created_at)
     VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000f9','K2','dev1','00000000-0000-0000-0000-0000000000a2','sales_invoice',gen_random_uuid(),'CREATE_DRAFT','{}',now())$q$,'duplicate key');

-- ---------- report ----------
SELECT id, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, name, detail FROM results ORDER BY id;
SELECT count(*) FILTER (WHERE ok) AS passed, count(*) FILTER (WHERE NOT ok) AS failed FROM results;
ROLLBACK;
