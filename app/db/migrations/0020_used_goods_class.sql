-- Used goods ("مستعمل"): bought and sold like everything else (suppliers, customers, cost, cash, stock, ledger) but their PROFIT is excluded from the partnership.
-- The class lives on the purchase line, travels with the stock layer (transfers keep it), and the sales line may only draw from layers of its own class,
-- so the cost of a used item is always the cost of that used item. Default PARTNERSHIP: existing data is unchanged.
ALTER TABLE purchase_lines ADD COLUMN profit_class text NOT NULL DEFAULT 'PARTNERSHIP' CHECK (profit_class IN ('PARTNERSHIP','USED'));
ALTER TABLE sales_lines    ADD COLUMN profit_class text NOT NULL DEFAULT 'PARTNERSHIP' CHECK (profit_class IN ('PARTNERSHIP','USED'));
ALTER TABLE stock_lots     ADD COLUMN profit_class text NOT NULL DEFAULT 'PARTNERSHIP' CHECK (profit_class IN ('PARTNERSHIP','USED'));
CREATE INDEX stock_lots_class ON stock_lots(product_id, location_id, profit_class) WHERE qty_remaining > 0;
