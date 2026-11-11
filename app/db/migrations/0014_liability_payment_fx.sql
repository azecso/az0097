-- Settling a foreign-currency liability (accrued expense, partner payable, salary) is measured at the PAYMENT rate:
-- the liability is cleared at its booked (accrual) rate, cash leaves at today's rate, the difference is realised FX (7100).
-- Existing rows keep NULL rate / 0 difference: they were booked at the accrual rate on both sides and are left untouched.
ALTER TABLE expense_payments ADD COLUMN exchange_rate_snapshot numeric(20,8), ADD COLUMN fx_diff_base numeric(20,4) NOT NULL DEFAULT 0;
ALTER TABLE payroll_payments ADD COLUMN exchange_rate_snapshot numeric(20,8), ADD COLUMN fx_diff_base numeric(20,4) NOT NULL DEFAULT 0;
