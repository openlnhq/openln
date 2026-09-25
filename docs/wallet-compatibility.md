# Wallet compatibility (what openLN connects to)

openLN is non-custodial: every account is backed by its own wallet. This is the
compatibility map for connecting that wallet - organized by connection type,
with live-verified facts separated from ecosystem claims. Updated 2026-09-25
from a full scan of the LN wallet landscape (sources at the bottom).

Money-path mechanics (the wrapped hold invoice, the 2% fee, settlement
observation) live in `docs/funding-sources.md`. This doc is about *which
wallets openLN accepts on which lane*.

## The three lanes

| Lane (`wallet_mode`) | What the user pastes | Capability |
|---|---|---|
| Nostr Wallet Connect (`custom` / `veil`) | `nostr+walletconnect://...` | Send + receive + balance + cards |
| API (`blink`) | provider API key | Send + receive + balance + cards (per key scopes) |
| Lightning Address (`lnaddress`) | `name@domain` | Receive-only (LUD-21 verify required) |

Any wallet connecting on the NWC or API lane is validated at connect time
(get_balance / test invoice). Lightning addresses are validated with an actual
LUD-21 `verify` probe: the address must serve a working `verify` URL from its
invoice callback, or openLN cannot confirm sales on the POS and the connect is
rejected. Wording in UI: "receive-only" (never "read-only").

## Providers by connection type (cleaned, 2026-09-25)

### Nostr Wallet Connect - send + receive

The whole group works through the generic NIP-47 lane - zero per-wallet code.
The list is the recognized ecosystem set; the lane accepts any NIP-47 wallet.

| Wallet | Notes |
|---|---|
| Alby Hub / Alby Cloud | Reference NWC service. Self-custodial; LDK embedded or remote LND / phoenixd / Cashu backend. openLN's own fee wallet runs on a self-hosted Hub. |
| LNbits | NWC plugin + NWCProvider (self-host or SaaS); can fund one instance from another. |
| Zeus | v0.12+: the phone wallet itself serves NWC to apps; also connects to LND / CLN / LNDhub / embedded node. |
| Coinos | Custodial web wallet; NWC + open-source REST server. Address serves LUD-21 (verified 2026-09-25). |
| Primal | Custodial, tied to Primal's Nostr client. Address does NOT serve LUD-21 (probed 2026-09-25). |
| Minibits | Cashu ecash wallet. |
| Blitz | Self-custodial, Spark + Lightning. |
| Flash | Self-custodial (Breez SDK); also offers business APIs + webhooks. |
| Electrum | Built-in NWC plugin (off by default; keep updated - had a spending-limit bypass advisory). |
| Rizful | Instant disposable cloud nodes. |
| LNCurl | Agent-first: create a wallet with one cURL call (custodial, shared Alby Hub backend). |
| Buho | Community-run custodial web wallet. |
| Club Orange | Social app with a wallet. |
| Bridges for node operators | CLN NWC plugins (daywalker90, gudnuf), LND NWC bridge, Strike NWC bridge (experimental), LNbits NWC service (experimental). Not advertised; works through the same lane where deployed. |
| Hosting | Nodana, Eggstr - cloud hosting for LNbits / Alby Hub instances. |
| Cashu.media set (Cashu.me, Nutstash, Bankify) | Experimental / foreground-only; not advertised on the landing wall. |

Caveats: NIP-47 method coverage varies per wallet (`make_invoice`,
`pay_invoice`, `lookup_invoice`, `get_balance`, notifications). Ecash (Cashu)
wallets have HTLC/ecash quirks on some flows. The connect-time `get_balance`
probe is the gate; deeper method gaps surface per sale and are handled by the
existing reconcile paths.

### API - send + receive (per-provider client work)

| Provider | API | openLN status |
|---|---|---|
| Blink | GraphQL + API keys (dev.blink.sv) | **LIVE** (custodial accounts; non-custodial accounts expose no API and use the Lightning Address lane) |
| Strike | REST (docs.strike.me) | To build. NWC only via an experimental community bridge - not a dependancy. |
| ZBD | REST (docs.zbdpay.com) | To build. No NWC. |
| Bitnob | REST (bitnob.dev; Lightning + stablecoins, Africa) | To build. |
| phoenixd | Local HTTP API (single binary, ACINQ) | Works today *indirectly*: phoenixd backs an Alby Hub, which serves NWC. Direct client not needed for the standard path. |
| BlueWallet | LNDhub API (self-host LNDhub, or BTCPay's LNDhub plugin) | Possible later; LNDhub has no create-invoice/webhook shape like the others - treat as node-side. |
| Coinos server | Open-source REST API (self-hosted Coinos) | Same as BlueWallet: possible, node-side. |
| LND / Core Lightning / Eclair / LDK | Node daemons with APIs | Reach openLN via NWC bridges or an Alby Hub on top; no direct client planned. |
| BTCPay Server | REST + LNDhub plugin + boltcard plugins | Possible later; the standard path is an Alby Hub / LNbits on top. |
| LNbits | Full platform API | Not needed - LNbits already reaches openLN through NWC. |

Integration shape for a new API wallet (follow `core/money/blink.ts`):
1. Client module in `core/money/` (auth, create invoice, pay invoice, lookup, balance).
2. `core/money/fundingInput.ts` classifier + `core/money/walletSource.ts` resolution.
3. Mint seam: `mintMerchantInvoice` in `core/money/holdWrap.ts` gets the new lane.
4. Settlement observation in `core/money/invoiceMonitor.ts` (poll or webhook).
5. Sending through `processExternalPayment` / `resolvePayFunding` in `core/money/feeEngine.ts`.
Never the fee wallet: the platform hold engine needs hold invoices, which none
of these APIs expose (Blink flat out has none).

### Lightning Address - receive-only

Live probe 2026-09-25: request a 1-sat invoice from the address's LNURL-pay
callback and check for the LUD-21 `verify` field.

| Provider | LUD-21 verify | Note |
|---|---|---|
| Blink | YES | Verified live on a *migrated non-custodial* account (`richardrjs59@blink.sv`) - the lane that keeps working after a custodial Blink account migrates. |
| Coinos | YES | Verified live (`kongzi@coinos.io`). |
| Alby | YES | Verified live on a getalby.com address. |
| Wallet of Satoshi | NO | No verify, no NWC, no official API - cannot back any lane. Company position: the connect is rejected; do not advertise WoS as compatible. |
| Primal | NO | No verify on addresses; Primal connects on the NWC lane only. |

### Dead ends (do not re-add)

- **Mutiny** - shut down end of 2024.
- **Wallet of Satoshi** - no official API, no NWC, no LUD-21. Community-built clients only, can break anytime.
- **Speed** - consumer app, no public wallet API; address behavior unverified. Nothing to connect with.

## Landing wall (`landing.html` `#compatibility`)

The wall is data-driven: `var COMPAT` in the landing script, one object per
wallet (`name`, `logo` at `/media/compat/<slug>.png`, `url`; `tag:'soon'`
marks integrations still being built; `ghost:true` renders the "+ any LUD-21
wallet" tile). Groups mirror the three lanes plus self-hosted. When an API
integration ships, remove its `soon` tag; when a wallet fails re-validation,
remove it from both the wall and the settings lists.

Logos live in `artifacts/web/media/compat/`. Logos are brand assets used
nominatively ("works with") - keep the wordmark unaltered and linked to the
provider's own site.

## Featured sets in the app UI

The connect modal (`walletModalModes()` in `index.html`) and the Settings
wallet card list the headline wallets per lane. Keep the three lists in sync:

- NWC: Alby Hub, LNbits, Zeus, Coinos, Primal, Minibits, Blitz, Flash, Electrum (and any NIP-47 wallet)
- Blink API: custodial Blink accounts (dashboard.blink.sv)
- Lightning Address: Blink, Coinos, Alby (and any LUD-21 wallet)

## Sources

- github.com/getAlby/awesome-nwc (canonical directory to watch), nwc.dev
- dev.blink.sv, docs.strike.me, docs.zbdpay.com, bitnob.dev
- zeusln.com v0.12 release notes, news.lnbits.com NWC guide
- Live probes on server1 (2026-09-25): LNURL-pay + LUD-21 verify against
  coinos.io, blink.sv, getalby.com, primal.net, walletofsatoshi.com
