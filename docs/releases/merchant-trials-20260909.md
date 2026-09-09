# Merchant trials release — 2026-09-09

## Scope

Wallet, RIC, Cards and Settings are the customer-facing product. Internal compile-time modules remain unchanged; the unused extensions marketplace is removed from the wallet UI.

## Regression coverage

Real PostgreSQL tests cover provisioning QR/URL identity, single-use atomic token redemption and renewal, correct RIC NDEF/SDM bytes, multi-card ownership, LUD-21 PIN advertisement and verification (bcrypt legacy + native scrypt), daily-limit enforcement, concurrent SUN replay, cancellation, reset QR, account-specific ZAR/rate-source/buy/sell configuration, invalid inputs, and revoked-device authentication. Unit tests protect the already-live 2% calculation, pending-send UI, firmware board guard, and environment URL selection.

Browser verification is performed with local Chromium against real API responses at 390px and 1440px: drawer, setup/renewal QR, two writing methods, name/limits/PIN edits, freeze/unfreeze, reset QR, settings persistence, and the Cards shop/studio/cart/legal navigation. No wallet balances or API responses are fabricated in the browser checks.

## Real payment evidence

- External 100-sat hold: `d4465957036561d4e28f005f45dfd46d910e2bb089d4c7dfd6c64297568f8009`. Merchant balance 980 → 1078 sats; fee 2 sats. `hold_minted → invoice_persisted → accepted → forwarding → forwarded → settled`.
- Card SUN + PIN callback: 21 sats, `40866648b8992ebb8c1697454c8382f0e77df7e95ca828068e018534e16a47c4`. Invoice paid, card ledger completed, destination balance +21.
- Unpaid invoice regression: merchant balance unchanged.
- Initial same-node hold attempt remains a separately tracked pending outcome; no retry was sent. Different NWC strings are not proof of different Lightning nodes. The external-payer test avoids self-pay.

## Boundaries

No physical device was attached. API contracts and existing binary were verified, not an actual flash, BLE pairing, physical NTAG424 write/wipe, or firmware mode-switch. Standard Web NFC cannot program NTAG424 security keys; the supported flow is browser issuance + Android creator app or RIC writing. The original bitPOS browser similarly supplies QR data, not browser APDU programming.

Cards frontend source: `kongzi/maekob` `959b68ff7a4d967c848fa62f80457d0d777f1983`, branch `prod-live`. A pinned two-build archive now travels through the same openLN ship dev/promote path. Production changes only the shop static root; existing shop API, database, sessions, orders and studio remain intact. `/cards-preview/` is read-only and noindexed.
