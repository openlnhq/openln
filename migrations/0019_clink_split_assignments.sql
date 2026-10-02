-- CLINK wallet connections + split send/receive assignments (2026-10).
-- A saved connection can now be a CLINK pointer from Lightning.Pub /
-- ShockWallet: 'noffer' (receives - openLN asks the wallet for an invoice
-- over Nostr) or 'ndebit' (sends - openLN hands the wallet an invoice to
-- pay). Both are static, shareable strings; only the per-connection app
-- key is secret and lives in clink_app_key_encrypted.
--
-- RIC and Cards assignments split into receive + send, because CLINK (and
-- half-capable wallets generally) can cover one direction each. Fallback
-- stays the account default. Idempotent: safe to re-run on every deploy.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER TABLE account_connections ADD COLUMN IF NOT EXISTS clink_pointer text;
ALTER TABLE account_connections ADD COLUMN IF NOT EXISTS clink_app_key_encrypted text;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ric_receive_connection_id uuid REFERENCES account_connections(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ric_send_connection_id uuid REFERENCES account_connections(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cards_receive_connection_id uuid REFERENCES account_connections(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cards_send_connection_id uuid REFERENCES account_connections(id) ON DELETE SET NULL;

-- One-time split of the old single per-feature pointer into both directions.
-- The legacy column is CONSUMED (set to NULL) in the same statement: a
-- re-run on a later deploy therefore copies nothing, so it can never
-- resurrect an assignment a user has since changed or cleared. Rolling the
-- app back past this change degrades those features to the default wallet
-- instead of restoring the old pointer - the intended trade so user edits
-- always win over migration replays.
UPDATE accounts SET
  ric_receive_connection_id = ric_connection_id,
  ric_send_connection_id = ric_connection_id,
  ric_connection_id = NULL
WHERE ric_connection_id IS NOT NULL
  AND ric_receive_connection_id IS NULL
  AND ric_send_connection_id IS NULL;

UPDATE accounts SET
  cards_receive_connection_id = cards_connection_id,
  cards_send_connection_id = cards_connection_id,
  cards_connection_id = NULL
WHERE cards_connection_id IS NOT NULL
  AND cards_receive_connection_id IS NULL
  AND cards_send_connection_id IS NULL;
