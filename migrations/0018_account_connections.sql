-- Named wallet connections (2026-10): an account can save more than one
-- wallet connection (NWC, Blink, Lightning Address, ...) and features pick
-- which connection they use. RIC and Cards each carry their own assignment;
-- both directions of a feature (send and receive) run through its assigned
-- connection, and what is possible depends on the wallet's capabilities
-- (send + receive for NWC/Blink, receive-only for Lightning Address).
-- Everything else (web POS, wallet screen, lightning address page) uses the
-- account's default connection.
-- Additive and idempotent: safe to re-run on every deploy.
CREATE TABLE IF NOT EXISTS account_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  mode text,
  label text,
  nwc_url_encrypted text,
  blink_api_key_encrypted text,
  blink_wallet_id text,
  blink_wallet_currency text,
  lightning_address text,
  lnurl_verify_supported boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_connections_account_idx ON account_connections (account_id);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS default_connection_id uuid REFERENCES account_connections(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ric_connection_id uuid REFERENCES account_connections(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cards_connection_id uuid REFERENCES account_connections(id) ON DELETE SET NULL;

-- Per-row snapshot: which saved connection funded this invoice / paid this
-- send. Settlement and reconciliation resolve the snapshot connection, so
-- reassigning a feature's wallet never reroutes money that is in flight.
ALTER TABLE pending_invoices ADD COLUMN IF NOT EXISTS connection_id uuid REFERENCES account_connections(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS connection_id uuid REFERENCES account_connections(id) ON DELETE SET NULL;

-- Backfill: every account that already had a wallet keeps it as its first
-- saved connection, and that connection becomes the account default. Guarded
-- so re-runs never duplicate rows.
INSERT INTO account_connections (account_id, kind, mode, label, nwc_url_encrypted, blink_api_key_encrypted, blink_wallet_id, blink_wallet_currency, lightning_address, lnurl_verify_supported)
SELECT a.id,
  CASE a.wallet_mode WHEN 'blink' THEN 'blink' WHEN 'lnaddress' THEN 'lnaddress' ELSE 'nwc' END,
  CASE a.wallet_mode WHEN 'veil' THEN 'veil' WHEN 'custom' THEN 'custom' ELSE NULL END,
  CASE a.wallet_mode WHEN 'blink' THEN 'Blink' WHEN 'lnaddress' THEN 'Lightning Address' ELSE 'Nostr Wallet Connect' END,
  a.custom_nwc_url, a.blink_api_key_encrypted, a.blink_wallet_id, a.blink_wallet_currency, a.lightning_address, a.lnurl_verify_supported
FROM accounts a
WHERE a.wallet_mode IN ('veil', 'custom', 'blink', 'lnaddress')
  AND NOT EXISTS (SELECT 1 FROM account_connections c WHERE c.account_id = a.id);

UPDATE accounts a SET default_connection_id = (
  SELECT c.id FROM account_connections c WHERE c.account_id = a.id ORDER BY c.created_at, c.id LIMIT 1
)
WHERE a.default_connection_id IS NULL
  AND EXISTS (SELECT 1 FROM account_connections c WHERE c.account_id = a.id);
