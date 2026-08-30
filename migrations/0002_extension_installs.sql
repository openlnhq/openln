-- extension marketplace per-account installs (created on dev 2026-08-24; missing from migrations)
CREATE TABLE IF NOT EXISTS extension_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  extension_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config_encrypted text,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, extension_id)
);
