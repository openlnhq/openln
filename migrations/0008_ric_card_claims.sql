-- A crash before the fee engine persists a send still retains this reservation.
CREATE TABLE IF NOT EXISTS ric_card_claims (
  card_id uuid PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id),
  payment_hash text NOT NULL,
  amount_sats bigint NOT NULL CHECK(amount_sats>0),
  created_at timestamptz NOT NULL DEFAULT now()
);
