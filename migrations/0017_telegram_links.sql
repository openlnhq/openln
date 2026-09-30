-- Telegram account links: ties a Telegram user (the support bot @openLN_bot)
-- to an openLN account so support reaches real users with their account
-- attached. Codes are minted in the app (Settings, Telegram support), shown
-- once to the signed-in user, and redeemed by the bot via /api/telegram/claim.
-- Idempotent: safe to re-run on every deploy.
CREATE TABLE IF NOT EXISTS telegram_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL UNIQUE REFERENCES entities(id) ON DELETE CASCADE,
  telegram_user_id bigint NOT NULL UNIQUE,
  username text,
  first_name text,
  linked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code text PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS telegram_link_codes_entity_idx ON telegram_link_codes (entity_id);
