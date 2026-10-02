-- CLINK offer webhooks (2026-10): Lightning.Pub / ShockWallet can push a
-- paid-callback to a per-offer URL the moment an invoice minted through the
-- offer gets paid (GET <url>?invoice={invoice}&amount={amount}&ok=true with
-- an optional Authorization: Bearer <token>). openLN uses that push as the
-- payment observer for CLINK offers: a noffer connection with a configured
-- hook can settle the direct fallback (sales keep working when the wrapped
-- path is unavailable) and every wrapped sale gets an independent
-- corroboration record.
--
-- clink_hook_id is public by design - it rides in the callback URL that the
-- merchant pastes into their wallet. clink_hook_secret_encrypted is the
-- bearer secret that authenticates the wallet, stored like every other
-- secret. Idempotent: safe to re-run on every deploy.
ALTER TABLE account_connections ADD COLUMN IF NOT EXISTS clink_hook_id text;
ALTER TABLE account_connections ADD COLUMN IF NOT EXISTS clink_hook_secret_encrypted text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_account_connections_clink_hook_id ON account_connections (clink_hook_id) WHERE clink_hook_id IS NOT NULL;

-- Webhook callbacks arrive with the paid invoice's bolt11; both lookup
-- columns are matched verbatim (merchant_bolt11 for wrapped rows, bolt11
-- for direct rows).
CREATE INDEX IF NOT EXISTS ix_pending_invoices_bolt11 ON pending_invoices (bolt11);
CREATE INDEX IF NOT EXISTS ix_pending_invoices_merchant_bolt11 ON pending_invoices (merchant_bolt11);
