-- Phase 8: company contact details printed in the footer of official documents (filled from Settings > Company; never hard-coded).
ALTER TABLE companies ADD COLUMN email text, ADD COLUMN website text, ADD COLUMN tax_no text;
