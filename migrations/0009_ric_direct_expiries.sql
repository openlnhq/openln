-- Durable direct-invoice expiry proof for cached RIC status after restart.
-- This is not wrap_status or failed-payment state. Keep direct invoices eligible
-- for late paid notifications; paid_at always takes precedence over expiry.
ALTER TABLE pending_invoices ADD COLUMN IF NOT EXISTS ric_expiry_confirmed_at timestamptz;
COMMENT ON COLUMN pending_invoices.ric_expiry_confirmed_at IS 'Fresh exact-hash own-wallet evidence confirmed direct invoice expiry. Never inferred from age alone; paid_at wins.';
INSERT INTO __openln_migrations(id) VALUES ('0009_ric_direct_expiries') ON CONFLICT (id) DO NOTHING;
