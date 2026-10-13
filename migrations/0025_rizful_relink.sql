-- Rizful one-click: keep the connection URI on the provision row (2026-10-13)
-- so a wallet the owner removed from Saved wallets can be re-linked in one
-- click, without creating a new Rizful account. Encrypted at rest like every
-- other wallet secret. Additive and idempotent: safe to re-run on every deploy.
ALTER TABLE rizful_provisions ADD COLUMN IF NOT EXISTS nwc_uri_encrypted text;
