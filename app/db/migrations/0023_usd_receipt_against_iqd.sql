-- Round 3: a USD receipt settling a dinar invoice WITHOUT a market/stored exchange rate. The user states the dollars received and the dinar balance that remains; the system records the
-- settlement equivalent (dinar balance before - dinar balance after) and the implied rate for accounting and audit only. These columns document that mode on the receipt.
ALTER TABLE customer_receipts ADD COLUMN usd_settlement boolean NOT NULL DEFAULT false;
ALTER TABLE customer_receipts ADD COLUMN outstanding_before numeric(20,4) CHECK (outstanding_before IS NULL OR outstanding_before >= 0);
ALTER TABLE customer_receipts ADD COLUMN remaining_after numeric(20,4) CHECK (remaining_after IS NULL OR remaining_after >= 0);
