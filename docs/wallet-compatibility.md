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

### API - direct integrations

**The wall lists only providers with a live connection.** Per-provider client
work; follow `core/money/blink.ts`. Anything still being built lives in the
integration queue below - never on the wall.

| Provider | API | Status |
|---|---|---|
| Blink | GraphQL + API keys (dev.blink.sv) | **LIVE** - the only API connection on the wall. Non-custodial accounts expose no API and use the Lightning Address lane instead. |

Integration queue (not on the wall; ships one at a time, live-verified first):

| Provider | API | Notes |
|---|---|---|
| Strike | REST (docs.strike.me) | NWC only via an experimental community bridge - not a dependency. Needs an account for the live test. |
| ZBD | REST (docs.zbdpay.com) | No NWC. Needs an account for the live test. |
| Bitnob | REST (bitnob.dev; Lightning + stablecoins, Africa) | Needs an account for the live test. |
| OpenNode | REST (developers.opennode.com; charges + withdrawals) | Custodial processor: `create charge` returns a Lightning invoice + webhooks; `POST /v2/withdrawals type:"ln"` pays a Lightning invoice - full send + receive. Needs an account + API key for the live test. |
| Speed | REST (apidocs.tryspeed.com; business platform) | Checkout sessions + Lightning payouts. The consumer app has no public API - the lane is a Speed business account. |
| CoinGate | REST (developer.coingate.com) | EU processor (~1% fees); Lightning enabled by default on accept; payouts + refunds APIs. |
| Coinsnap | REST (docs.coinsnap.io; store ID + API key) | Receive-only: self-custody acceptance - settles straight to the merchant's own wallet. |
Node-side paths (reach openLN through NWC; no direct client needed):
LND / Core Lightning / Eclair / LDK via NWC bridges, phoenixd via an Alby Hub,
BlueWallet / Coinos server / BTCPay / LNbits through their own platforms - the
standard path is an Alby Hub or LNbits on top.

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

### Processors evaluated, parked (not on the wall)

The 2026 processor layer was swept separately from the awesome-nwc wallet scan
(watch: Voltage "Best bitcoin payment APIs 2026", Chainstack payments list,
Speed/OpenNode comparisons). Beyond the four added to the API table:

- **BitPay** - invoices + payouts APIs, but Lightning support reads as limited in the REST docs; verify before claiming.
- **IBEX** - real Lightning settlement (IBEX Pay retail; poweredbyibex institutional) but per-merchant / enterprise onboarding; no self-serve wallet API for openLN merchants today.
- **Voltage / Lightspark / Blockstream Greenlight** - platform and node infrastructure, not merchant wallets; the self-hosted group already covers this class.
- **NOWPayments / Crypto.com Pay / Coinbase Commerce / Coinify / Nuvei** - no meaningful Lightning support. Excluded.

## Landing wall (`landing.html` `#compatibility`)

The wall is data-driven: `var COMPAT` in the landing script, one object per
wallet (`name`, `logo` at `/media/compat/<slug>.png`, `url`; `ghost:true`
renders a universal tile - "+ Any NWC wallet", "+ Any LUD-21 wallet"). Groups
mirror the three lanes plus self-hosted. **List only wallets that connect
today**: a provider appears on the wall when its connection is live and
verified, and comes off if it fails re-validation. No "coming soon" entries.

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
- developers.opennode.com, apidocs.tryspeed.com, developer.coingate.com, docs.coinsnap.io (processor APIs verified 2026-09-25)
- zeusln.com v0.12 release notes, news.lnbits.com NWC guide
- Live probes on server1 (2026-09-25): LNURL-pay + LUD-21 verify against
  coinos.io, blink.sv, getalby.com, primal.net, walletofsatoshi.com
