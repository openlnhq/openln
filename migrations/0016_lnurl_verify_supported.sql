-- Lightning Address funding: remember whether the provider serves a LUD-21
-- verify URL. Verify-less providers (Wallet of Satoshi) connect as
-- wrapped-only: every sale settles on the platform node through the wrapped
-- hold path, and the direct fallback refuses instead of minting an invoice
-- nothing could observe (policy A, 2026-09-30).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS lnurl_verify_supported boolean;
-- Accounts that connected before this column existed all passed the LUD-21
-- gate, so they are verify-capable. (NULL in code also reads as verify-capable.)
UPDATE accounts SET lnurl_verify_supported = true
  WHERE wallet_mode = 'lnaddress' AND lnurl_verify_supported IS NULL;
