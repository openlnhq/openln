-- Rizful one-click: record terms acceptance (2026-10-13). The Settings card
-- requires ticking "I accept Rizful's terms" before a run can start; the
-- accept time is stored per run for the consent trail.
-- Additive and idempotent: safe to re-run on every deploy.
ALTER TABLE rizful_provisions ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
