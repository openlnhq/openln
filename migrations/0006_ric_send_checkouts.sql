-- RIC send authorization and recovery live outside the verbatim money engine.
-- A checkout belongs to one account and may commit one dispatch, via QR or NFC.
CREATE TABLE IF NOT EXISTS ric_send_checkouts (
  k1 text PRIMARY KEY CHECK (k1 ~ '^[0-9a-f]{64}$'),
  account_id uuid NOT NULL REFERENCES accounts(id),
  amount_sats bigint NOT NULL CHECK (amount_sats > 0 AND amount_sats <= 9007199254740991 / 1000),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','preparing','pending','paid','failed','cancelled','expired')),
  channel text CHECK (channel IN ('qr','card')),
  payer_nwc_encrypted text NOT NULL,
  bolt11 text,
  payment_hash text,
  recipient_account_id uuid REFERENCES accounts(id),
  card_id uuid REFERENCES cards(id),
  outgoing_tx_id uuid REFERENCES transactions(id),
  receipt_tx_id uuid REFERENCES transactions(id),
  dispatched_at timestamptz,
  paid_at timestamptz,
  fee_sats bigint NOT NULL DEFAULT 0,
  failure_reason text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  CHECK (dispatched_at IS NULL OR (bolt11 IS NOT NULL AND payment_hash IS NOT NULL AND channel IS NOT NULL)),
  CHECK (state NOT IN ('pending','paid') OR dispatched_at IS NOT NULL),
  CHECK (state NOT IN ('ready','preparing','expired','cancelled') OR dispatched_at IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ric_send_checkouts_invoice_once
  ON ric_send_checkouts(account_id, payment_hash) WHERE payment_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ric_send_checkouts_recovery
  ON ric_send_checkouts(checked_at NULLS FIRST, created_at) WHERE state IN ('pending','preparing');
GRANT SELECT, INSERT, UPDATE ON ric_send_checkouts TO openln;
INSERT INTO __openln_migrations(id) VALUES ('0006_ric_send_checkouts') ON CONFLICT (id) DO NOTHING;
