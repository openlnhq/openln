-- Partner suite: payout execution fields + device-MAC attribution on sales.
-- Additive and idempotent (deploy.sh applies every migration on each run).
ALTER TABLE partner_accounts ADD COLUMN IF NOT EXISTS lightning_address text;
ALTER TABLE partner_payouts ADD COLUMN IF NOT EXISTS destination text;
ALTER TABLE partner_payouts ADD COLUMN IF NOT EXISTS bolt11 text;
ALTER TABLE partner_payouts ADD COLUMN IF NOT EXISTS payment_hash text;
ALTER TABLE partner_payouts ADD COLUMN IF NOT EXISTS preimage text;
ALTER TABLE partner_payouts ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE partner_payouts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE partner_earnings ADD COLUMN IF NOT EXISTS device_mac text;
ALTER TABLE pending_invoices ADD COLUMN IF NOT EXISTS device_mac text;
ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS mac varchar(32);
CREATE INDEX IF NOT EXISTS partner_earnings_partner_created_idx ON partner_earnings(partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS partner_payouts_partner_created_idx ON partner_payouts(partner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS partner_payouts_state_idx ON partner_payouts(state);
CREATE INDEX IF NOT EXISTS posbox_devices_attribution_partner_idx ON posbox_devices_attribution(partner_id);
CREATE INDEX IF NOT EXISTS pending_invoices_device_mac_idx ON pending_invoices(device_mac) WHERE device_mac IS NOT NULL;
CREATE INDEX IF NOT EXISTS device_tokens_mac_idx ON device_tokens(mac) WHERE mac IS NOT NULL;
