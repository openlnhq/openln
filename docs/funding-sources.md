# Merchant funding sources (NWC, Blink API, Lightning Address)

An account's wallet is its **funding source**: the wallet that receives card
(RIC) and POS payments. openLN is non-custodial and never holds funds; it asks
the funding source to mint one invoice per sale, inside the wrapped hold
invoice engine that collects the 2% fee ("we pay 98 to get 100").

Three lanes, all through the same single connect field:

| Lane (`wallet_mode`) | What the merchant pastes | Capability |
|---|---|---|
| `custom` / `veil` (NWC) | `nostr+walletconnect://...` | Full: receive, send, balance, cards |
| `blink` | Blink API key (`blink_...`) | Full: receive, send, balance, cards - **custodial accounts only**. Read + Receive scopes are enough for receive/balance; sending needs **Write** on the key. Blink's non-custodial (Spark) accounts expose no API at all ("API will not be available") and use the Lightning Address lane |
| `lnaddress` | Lightning Address (`name@provider.com`) | Receive only. Works with any wallet whose address supports LNURL-pay and LUD-21 verify (Blink, and others) |

## How it works

- **Classify** (`core/money/fundingInput.ts`): one input, shape-based:
  `nostr+walletconnect://` = NWC, `blink_...` = Blink, `name@domain` = Lightning
  Address. The connect route validates the detected kind: NWC via get_balance,
  Blink via wallets + a 1-sat test invoice, Lightning Address via LNURL-pay +
  a LUD-21 `verify` probe (rejected without verify, because settlement could
  not be shown).
- **Resolve** (`core/money/walletSource.ts`): `WalletSource` (nwc | blink |
  lnaddress | none) and `MerchantFunding`, the mint-seam input.
- **Mint seam** (`core/money/holdWrap.ts`, `mintMerchantInvoice`): the ONE
  money-path touchpoint. It mints the merchant's invoice for
  `amount - fee` per lane (NWC `make_invoice`, Blink `lnInvoiceCreate`, LNURL-pay
  callback request). Everything else in the wrap engine (hold, forward,
  settle, fee) stays on the platform wallet and is lane-independent. Blink can
  never host the hold itself: its API has no hold invoices, so the fee wallet
  stays on the Alby Hub.
- **Fallback**: if wrapping is unavailable, each lane falls back to a direct
  invoice so a sale is never blocked (fee not collected on that sale).
- **Settlement observation** (`core/money/invoiceMonitor.ts`): NWC rows via
  `list_transactions` / `lookup_invoice`; Lightning Address rows via their
  LUD-21 verify URL; Blink rows via `lnInvoicePaymentStatusByPaymentRequest`.
  Blink and LNURL rows are HTTPS only, no relay involved.
- **Blink account states**: an account Blink has disabled for receiving
  (region wind-down / migration, seen live as "This account can no longer
  receive payments. ... migrate your funds") is surfaced with that guidance
  instead of a misleading permission hint - both at connect validation and at
  sale-time invoice minting. After a custodial account migrates to
  non-custodial (Spark) the API key stops working entirely (HTTP 401; Blink:
  "API will not be available"), while the Lightning Address keeps working and
  still serves LUD-21 - verified live on a migrated account, so the
  Lightning Address lane is the integration path for all non-custodial Blink
  accounts.
- **Sending** (all four send surfaces - web pay, RIC withdraw, send-to-card,
  card taps - funnel through `processExternalPayment` in `core/money/feeEngine.ts`,
  which resolves the paying wallet via `resolvePayFunding`):
  - NWC lane: `pay_invoice` on the relay (unchanged).
  - Blink lane: `lnInvoicePaymentSend` over HTTPS (needs the Write scope).
    Same money rules as NWC: a clean reply is definitive
    (`SUCCESS`/`ALREADY_PAID` -> completed, `FAILURE` -> failed with the
    wallet's reason); a network error, timeout, 5xx, or `PENDING` status is
    **ambiguous** (`BlinkAmbiguousError`) - the row stays `pending`, never
    retried, and is finalized from the wallet's own record.
  - Outgoing reconciliation (`reconcilePendingSends`): Blink rows resolve via
    `transactionsByPaymentHash` on the merchant's wallet (`SUCCESS` ->
    completed, `FAILURE` -> failed, `PENDING`/no record -> leave pending);
    NWC rows keep their relay-based lookup. A missing Write scope surfaces as
    an actionable message pointing at dashboard.blink.sv.
- **Storage** (`migrations/0012_blink_funding.sql`): `blink_api_key_encrypted`
  (AES-256-GCM via `core/money/encrypt.ts`), `blink_wallet_id`,
  `blink_wallet_currency`. The Lightning Address is public and stored as-is in
  `lightning_address`.

## UI

The connect sheet has three tabs (NWC, Blink, Lightning Address). A receive-only
account shows a "Receive-only" wallet view: the balance line states the balance
stays in the funding wallet, Send is disabled with an explanation, and Receive
works (RIC + browser POS) exactly like NWC accounts.

## Tests

Live verification (2026-09-24, server1): a complete wrapped sale ran against a
migrated non-custodial Blink account (`richardrjs59@blink.sv`) through the
Lightning Address lane on the QA stack: customer paid 100 sats -> hold
accepted -> merchant invoice paid (98 sats to the Blink address) -> hold
settled, fee 2 sats captured; hub record shows the outgoing `settled` with
0.248 sats routing, and the merchant books recorded a 98-sat receive. The
custodial API key for the same account returns HTTP 401 after migration
(Blink: "API will not be available"), which is why the address lane is the
non-custodial path.

The Blink send lane has its own integration coverage in
`tests/funding-sources.integration.mjs`: Write-scope success (row booked
`completed` with the payment hash), a definitive `FAILURE` (400 to the caller,
row `failed`), and an ambiguous `PENDING` reply (202, row stays `pending`; the
reconciler leaves it until the ledger record appears, then books
`completed`/`failed` from `transactionsByPaymentHash`). Lightning Address
sends are refused with a receive-only message.

- Unit: `DATABASE_URL=postgresql://127.0.0.1/openln_test node --test dist/core/money/money-path.test.js tests/*.test.mjs`
- Integration (scratch DB guard requires `/openln_qa_*`):
  `DATABASE_URL=postgresql://127.0.0.1/openln_qa_<x> SESSION_SECRET=<any> node --test --test-force-exit tests/*.integration.mjs`
- `--test-force-exit` is required on Node 24: the in-process test server plus
  the invoice monitor keep the event loop alive after the tests finish.
- `tests/funding-sources.integration.mjs` is hermetic: DNS and `fetch` are
  stubbed in-process (`ln.test` provider, `BLINK_API_URL` stub host), so no
  real wallet or public network is touched. The Blink client reads
  `BLINK_API_URL` (default `https://api.blink.sv/graphql`) for this.

## Still open (not in this change)

- Webhooks (`receive.lightning`) / websocket subscription as a settlement
  accelerator on top of the current polling.
- OAuth2 (user-consent flow) so merchants do not paste a raw API key.
- An openLN-side spend guard for Blink Write keys (the Blink CLI's
  `BLINK_BUDGET_*` precedent): today the guardrail is the API key's own scope,
  which is server-enforced by Blink but unbounded.
- `processInternalPayment` (in-network transfer) is unused legacy code and
  still assumes the receiver has an NWC URL; openLN-to-openLN transfers to
  Blink / Lightning Address receivers are not wired.
