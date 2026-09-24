# Merchant funding sources (NWC, Blink API, Lightning Address)

An account's wallet is its **funding source**: the wallet that receives card
(RIC) and POS payments. openLN is non-custodial and never holds funds; it asks
the funding source to mint one invoice per sale, inside the wrapped hold
invoice engine that collects the 2% fee ("we pay 98 to get 100").

Three lanes, all through the same single connect field:

| Lane (`wallet_mode`) | What the merchant pastes | Capability |
|---|---|---|
| `custom` / `veil` (NWC) | `nostr+walletconnect://...` | Full: receive, send, balance, cards |
| `blink` | Blink API key (`blink_...`, Read + Receive scopes) | Receive + balance now. Send/cards are phase 2 (needs Write scope plus the openLN send-path wiring) |
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

- Unit: `DATABASE_URL=postgresql://127.0.0.1/openln_test node --test dist/core/money/money-path.test.js tests/*.test.mjs`
- Integration (scratch DB guard requires `/openln_qa_*`):
  `DATABASE_URL=postgresql://127.0.0.1/openln_qa_<x> SESSION_SECRET=<any> node --test --test-force-exit tests/*.integration.mjs`
- `--test-force-exit` is required on Node 24: the in-process test server plus
  the invoice monitor keep the event loop alive after the tests finish.
- `tests/funding-sources.integration.mjs` is hermetic: DNS and `fetch` are
  stubbed in-process (`ln.test` provider, `BLINK_API_URL` stub host), so no
  real wallet or public network is touched. The Blink client reads
  `BLINK_API_URL` (default `https://api.blink.sv/graphql`) for this.

## Phase 2 (not in this change)

- Blink send + cards (Write scope; separate explicit opt-in, plus an openLN
  spend guard following the Blink CLI's `BLINK_BUDGET_*` precedent).
- Webhooks (`receive.lightning`) / websocket subscription as a settlement
  accelerator on top of the current polling.
- OAuth2 (user-consent flow) so merchants do not paste a raw API key.
- In-network transfers (`feeEngine.transferInNetwork`) to Blink/Lightning
  Address receivers currently stop at "No wallet configured for receiver"
  because neither lane has an openLN-internal spendable wallet.
