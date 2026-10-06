-- Latest app-presence observation per account (admin Userbase console).
-- Idempotent on purpose: the deploy re-runs every migration file.
CREATE TABLE IF NOT EXISTS account_activity (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  last_ip text,
  last_timezone text,
  last_user_agent text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
