CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE account_type AS ENUM ('personal', 'business');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE transaction_direction AS ENUM ('in', 'out');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE transaction_type AS ENUM ('receive', 'send', 'internal_receive', 'internal_send', 'yield', 'swap', 'swap_refund', 'fee');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE transaction_status AS ENUM ('pending', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE card_status AS ENUM ('active', 'frozen', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE, handle text NOT NULL UNIQUE,
  phone text, phone_verified boolean NOT NULL DEFAULT false, pin_hash text NOT NULL,
  password_hash text, pin_upgraded boolean NOT NULL DEFAULT false, totp_secret text,
  totp_enabled boolean NOT NULL DEFAULT false, totp_recovery_codes text, recovery_email text,
  recovery_email_verified_at timestamptz, login_fail_count integer NOT NULL DEFAULT 0,
  login_locked_until timestamptz, is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entities_is_system_idx ON entities (is_system);

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL REFERENCES entities(id),
  type account_type NOT NULL DEFAULT 'personal', business_name text, business_active boolean NOT NULL DEFAULT false,
  currency text NOT NULL DEFAULT 'usd', rate_source text NOT NULL DEFAULT 'coingecko', rate_modifier text,
  send_rate_modifier text, alby_sub_wallet_nwc_url text, nostr_priv_key_encrypted text,
  nostr_pub_key text, wallet_mode text NOT NULL DEFAULT 'veil', custom_nwc_url text,
  lightning_address text, balance_sats bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id),
  status card_status NOT NULL DEFAULT 'active', aes_key_0 text NOT NULL, aes_key_1 text NOT NULL,
  aes_key_2 text NOT NULL, aes_key_3 text NOT NULL, aes_key_4 text NOT NULL, uid text, name text, note text,
  counter integer NOT NULL DEFAULT 0, per_tap_limit_sats bigint NOT NULL DEFAULT 50000,
  daily_limit_sats bigint NOT NULL DEFAULT 500000, phone_verified_at_issuance boolean NOT NULL DEFAULT false,
  last_used_at timestamptz, pending_k1 text, pending_k1_expires_at timestamptz,
  provision_token text, provision_token_expires_at timestamptz, wipe_token text, wipe_token_expires_at timestamptz,
  pin_hash text, pin_limit_msats bigint, pin_fail_count integer NOT NULL DEFAULT 0, pin_locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pending_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id),
  bolt11 text NOT NULL, payment_hash text NOT NULL UNIQUE, amount_sats bigint NOT NULL, memo text,
  nwc_url_encrypted text, card_order_id uuid, merchant_bolt11 text, merchant_payment_hash text,
  fee_sats bigint, wrap_status text, preimage text, hold_preimage text, lnurl_verify_url text,
  fiat_currency text, fiat_amount text, fiat_base_rate text, fiat_effective_rate text, fiat_modifier text,
  fiat_rate_source text, fiat_rate_direction text, fiat_rate_at timestamptz, wrap_updated_at timestamptz,
  expires_at timestamptz NOT NULL, paid_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id),
  direction transaction_direction NOT NULL, amount_sats bigint NOT NULL, fee_sats bigint NOT NULL DEFAULT 0,
  type transaction_type NOT NULL, counterpart_handle text, counterpart_ln_address text, bolt11 text,
  payment_hash text, status transaction_status NOT NULL DEFAULT 'completed', memo text,
  card_id uuid REFERENCES cards(id), failure_reason text, fiat_currency text, fiat_amount text,
  fiat_base_rate text, fiat_effective_rate text, fiat_modifier text, fiat_rate_source text,
  fiat_rate_direction text, fiat_rate_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transactions_account_id_created_at_idx ON transactions (account_id, created_at);

CREATE TABLE IF NOT EXISTS payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id text NOT NULL,
  account_id uuid REFERENCES accounts(id), kind text NOT NULL, event text NOT NULL,
  status text NOT NULL DEFAULT 'info', mile text, message text, method text,
  payment_hash text, merchant_payment_hash text, amount_sats integer, fee_sats integer,
  duration_ms integer, detail jsonb, error_class text, error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_events_payment_id_idx ON payment_events (payment_id);
CREATE INDEX IF NOT EXISTS payment_events_payment_hash_idx ON payment_events (payment_hash);
CREATE INDEX IF NOT EXISTS payment_events_created_at_idx ON payment_events (created_at);
CREATE INDEX IF NOT EXISTS payment_events_account_id_idx ON payment_events (account_id);
CREATE INDEX IF NOT EXISTS payment_events_status_idx ON payment_events (status);
CREATE INDEX IF NOT EXISTS payment_events_kind_idx ON payment_events (kind);

-- Drizzle-compatible migration journal, allowing this file to be applied idempotently.
CREATE TABLE IF NOT EXISTS __openln_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO __openln_migrations (id) VALUES ('0000_openln_core') ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE payment_events IS 'Append-only redacted payment flight recorder; application writes never block money operations';
COMMENT ON TABLE transactions IS 'Payment ledger; pending is the only safe state for ambiguous sends';
COMMENT ON COLUMN payment_events.detail IS 'Redacted JSON payload; never persist secrets, NWC URIs, or preimages';
COMMENT ON COLUMN payment_events.created_at IS 'Insertion order/timeline timestamp; rows are append-only';
COMMENT ON COLUMN transactions.status IS 'pending must remain queryable for ambiguous wallet responses';

-- The runtime connects as the dedicated openln role on the destination host.
GRANT SELECT, INSERT, UPDATE ON entities, accounts, cards TO openln;
GRANT SELECT, INSERT, UPDATE ON pending_invoices, transactions TO openln;
GRANT SELECT, INSERT ON payment_events TO openln;

-- Guard the flight recorder against accidental mutation while allowing the app's append path.
CREATE OR REPLACE FUNCTION prevent_payment_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'payment_events is append-only'; END; $$;
DROP TRIGGER IF EXISTS payment_events_no_mutation ON payment_events;
CREATE TRIGGER payment_events_no_mutation BEFORE UPDATE OR DELETE ON payment_events
FOR EACH ROW EXECUTE FUNCTION prevent_payment_event_mutation();

CREATE OR REPLACE FUNCTION prevent_transaction_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'transactions are append-only'; END; $$;
DROP TRIGGER IF EXISTS transactions_no_delete ON transactions;
CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions
FOR EACH ROW EXECUTE FUNCTION prevent_transaction_delete();
