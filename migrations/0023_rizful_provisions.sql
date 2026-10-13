-- Rizful one-click wallet provisioning (2026-10): openLN can create a Rizful
-- vault (custodial Lightning wallet by Megalithic) for the user in one action,
-- link its NWC connection, and hand the login back to the owner. This table
-- tracks each run and keeps what the owner needs: the Rizful login (display
-- email + encrypted password) and the temporary mailbox used for email
-- verification, so access can be recovered later.
-- Additive and idempotent: safe to re-run on every deploy.
CREATE TABLE IF NOT EXISTS rizful_provisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',            -- pending | running | done | error
  step text,                                          -- human-readable current step
  error text,
  rizful_email text,                                  -- the login handle (display only)
  rizful_password_encrypted text,
  lightning_address text,
  mailbox_address text,
  mailbox_password_encrypted text,
  mailbox_token_encrypted text,
  connection_id uuid REFERENCES account_connections(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rizful_provisions_account_idx ON rizful_provisions (account_id, created_at DESC);
