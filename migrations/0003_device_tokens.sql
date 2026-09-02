-- RIC device tokens: account-scoped auth tokens issued to linked RIC devices (ported verbatim from bitPOS device_tokens)
CREATE TABLE IF NOT EXISTS device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token varchar(64) NOT NULL UNIQUE,
  label varchar(80) NOT NULL DEFAULT 'RIC',
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
