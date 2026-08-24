# Isolated NWC wallet setup for Phase 2 E2E

The E2E uses three distinct NWC connections. This is required: Alby Hub cannot settle a hold invoice paid by the same wallet that minted it.

Roles:

- `NWC_TEST_URL`: platform wallet. Mints the hold and supplies the forwarding float.
- `NWC_USER_URL`: funded sender wallet. Pays the customer-facing hold.
- `NWC_SENDER_URL`: merchant wallet. Receives `amount - 1%`.

Create three fresh connections in the wallet provider's test accounts, fund the sender and platform, and revoke all three after the run. The repository does not create custodial wallets and never stores provider credentials. Do not use `~/openln/.env` or the systemd `ALBY_NWC_URL`; those are deployment/production-shaped state.

## Run

1. Copy `nwc-e2e.env.example` to a file outside the repository (for example `/run/user/$UID/openln-nwc-e2e.env`), replace placeholders, and run `chmod 600`.
2. Use an isolated PostgreSQL database named `openln_test`; it must not be `openln_dev`. Apply the committed migrations before running the readiness check.
3. Build first, then execute:

```sh
pnpm build
NWC_E2E_ENV_FILE=/run/user/$UID/openln-nwc-e2e.env \
DATABASE_URL=postgresql://openln_test@127.0.0.1:5432/openln_test \
node scripts/e2e-wallet-readiness.mjs
```

The command exits non-zero unless all three URLs are valid and distinct, the env file is mode 600, each wallet responds to NWC probing (`get_balance`, `make_invoice`, `lookup_invoice`), sender balance is at least 1,000 sats, and platform float is at least 1,010 sats. Success is one JSON line with `ready:true`, roles, balances, database name, and `plugins:[]`. It never prints URLs or secrets.

The script rejects production variables (`ALBY_NWC_URL`, `SESSION_SECRET`, and an inline `DATABASE_URL` in the wallet env file) and refuses an implicit shell environment file. It does not mint an invoice, pay anything, or mutate wallet state, so it is safe to run repeatedly before the actual E2E.

## Cleanup

After the E2E reaches a terminal state and database evidence is captured, revoke the three NWC connections at the provider and securely delete the 600-mode env file. Drop `openln_test` or truncate its test tables; never run cleanup against `openln_dev`. Any ambiguous hold must be reconciled by hash before revocation, not paid again.

The readiness script is `scripts/e2e-wallet-readiness.mjs`; the non-secret template is `nwc-e2e.env.example`.

## No-plugin invariant

The core registry has no registrations in the E2E process. The readiness output includes `plugins:[]`; the HTTP health endpoint must likewise report an empty plugin list before money-path tests begin.
