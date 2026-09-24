-- Funding sources: add the Blink API wallet lane alongside NWC (full) and
-- Lightning Address (receive-only). Stores the merchant's own Blink API key
-- (encrypted by the app) plus the resolved Blink BTC wallet id and currency,
-- so the receive path needs no extra lookup per sale.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS blink_api_key_encrypted text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS blink_wallet_id text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS blink_wallet_currency text;
