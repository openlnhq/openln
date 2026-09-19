-- Books: every money movement gets a bookkeeping class so accountants never tax a top-up or a
-- transfer to the merchant's own wallet as a sale. The class is set where the row is written
-- (RIC sale, LN-address receive, card spend, wallet top-up...) and can be corrected by the
-- account holder. Fiat value at the moment of the transaction was already recorded on the
-- row; this adds the classification, an editable note, and business details for the report
-- letterhead. Idempotent.

DO $$ BEGIN
  CREATE TYPE transaction_class AS ENUM (
    'sale',          -- revenue: customer paid for goods/services (RIC, web POS, LN address with a memo)
    'top_up',        -- owner moved own funds INTO the wallet (not income)
    'transfer_out',  -- owner moved own funds OUT to another wallet they control (not an expense)
    'spend',         -- purchase paid from the wallet (card tap, invoice paid)
    'refund',        -- money returned to a customer (contra revenue)
    'fee',           -- platform / routing fee
    'other'          -- unclassified: shows up in the report's "needs review" section
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS class transaction_class;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS class_source text;       -- 'system' | 'user'
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS origin text;             -- 'ric' | 'web_pos' | 'ln_address' | 'wallet' | 'card' | 'internal' | 'shop'
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS note text;               -- account holder's own note for the books
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference text;          -- receipt / invoice number (free text)
ALTER TABLE pending_invoices ADD COLUMN IF NOT EXISTS origin text;         -- ric | web_pos | ln_address | wallet | shop

-- Backfill classes for existing rows from what we know. Owner can override any of these.
UPDATE transactions SET class = 'fee', class_source = 'system' WHERE class IS NULL AND type = 'fee';
UPDATE transactions SET class = 'spend', class_source = 'system', origin = COALESCE(origin, 'card')
  WHERE class IS NULL AND direction = 'out' AND card_id IS NOT NULL;
UPDATE transactions SET class = 'sale', class_source = 'system', origin = COALESCE(origin, 'ric')
  WHERE class IS NULL AND direction = 'in' AND type = 'receive' AND fiat_amount IS NOT NULL;
UPDATE transactions SET class = 'sale', class_source = 'system', origin = COALESCE(origin, 'ln_address')
  WHERE class IS NULL AND direction = 'in' AND type = 'receive' AND memo IN ('openLN payment', 'POS payment');
UPDATE transactions SET class = 'transfer_out', class_source = 'system', origin = COALESCE(origin, 'ric')
  WHERE class IS NULL AND direction = 'out' AND memo IN ('RIC send', 'RIC send to card');
UPDATE transactions SET class = 'spend', class_source = 'system', origin = COALESCE(origin, 'wallet')
  WHERE class IS NULL AND direction = 'out' AND type = 'send';
UPDATE transactions SET class = 'sale', class_source = 'system', origin = COALESCE(origin, 'internal')
  WHERE class IS NULL AND direction = 'in' AND type = 'internal_receive';
UPDATE transactions SET class = 'other', class_source = 'system' WHERE class IS NULL;

CREATE INDEX IF NOT EXISTS transactions_account_class_created_idx ON transactions (account_id, class, created_at);

-- Business details printed on the report letterhead. One row per account.
CREATE TABLE IF NOT EXISTS business_profiles (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  legal_name text,
  trading_name text,
  tax_id text,
  address text,
  city text,
  country text,
  email text,
  phone text,
  fiscal_year_start_month integer NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  report_currency text,            -- defaults to the account currency when null
  updated_at timestamptz NOT NULL DEFAULT now()
);
