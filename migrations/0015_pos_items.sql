-- POS items: the merchant's item catalog for the in-app point of sale (web POS).
-- Name, fiat price (decimal string in the account's configured currency), optional
-- description and photo thumbnail (small data URL, downscaled in the browser).
-- The checkout converts fiat to sats at the live account rate; the invoice itself
-- stays sats-only. Idempotent: safe to re-run on every deploy.
CREATE TABLE IF NOT EXISTS pos_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  price text NOT NULL,
  description text,
  photo text,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_items_account_idx ON pos_items (account_id, sort, created_at);
