# RIC production review and release acceptance

Scope: ESP32-2432S028R, classic ESP32, RIC firmware 1.0.6 baseline.
Review date: 2026-09-14. Candidate: 1.0.7. Core Lightning money modules remain unchanged.

## Findings and corrections

| Priority | Baseline defect | Corrective boundary |
|---|---|---|
| P0 | Callback transport errors shown as failed, encouraging duplicate payment | Typed outcomes, journal before submission, query-only recovery, no automatic pay retry |
| P0 | QR and card-send routes could race one withdrawal or pay an invoice above authorized amount | One durable shared checkout, exact amount validation and atomic dispatch claim |
| P0 | PN532 unchecked UID/frame lengths and QR encoder undersized buffers | Vendored bounded PN532 framing, NLEN validation, capacity-checked single QR encode, sanitizer regressions |
| P1 | Display/task stopped during TLS and NFC calls | Separate persistent network and NFC workers; only the loop task owns display and touch |
| P1 | One-minute device deadline and frozen animation | Ten-minute customer window, rollover-safe monotonic timer, continuously updated indeterminate progress |
| P1 | Background settlement monitor never started; expired wraps aged out of request cleanup | Bounded autonomous DB-backed recovery with no unresolved-wrap age cutoff; status HTTP no longer awaits Lightning |
| P1 | Wrong PIN consumed the only challenge; string-matching incorrectly treated network errors as wrong PIN | Structured pre-dispatch rejection with atomic challenge rearm and retained three-attempt card lock |
| P1 | Merchant send PIN had no bounded attempts | Separate per-account send authorization throttle, persisted in PostgreSQL |
| P1 | Pending card spend stopped blocking after 15 minutes | Proof-only release and durable per-card reservation, checked under row lock |
| P1 | Public card HTTPS used insecure TLS and every card stage tore down the managed connection | CA and hostname verification; same-origin socket reused without sending device authorization to public routes |
| P2 | Countdown could erase sats; QR quiet zone too small; artificial pre-request progress | Reserved measured text zones, complete four-module white margin, real font raster tests, no fake completion percentage |

Primary source locations: `firmware/esp32-pos/src/main.cpp`, `src/api/BitposClient.cpp`, `src/screens/PaymentScreen.cpp`, `src/core/CheckoutJournal.h`, vendored `lib/Adafruit-PN532-NTAG424`, `core/ric-reconcile.ts`, `plugins/card-tap.ts`, `plugins/ric-payment-store.ts`, and `plugins/ric-card-claim.ts`.

## Financial invariants

- Acceptance is not settlement. RIC shows success only from a confirmed status for the exact stored reference.
- The ten-minute window closes new customer interaction. It never turns an uncertain submitted payment into a failure.
- Wi-Fi, relay, server, JSON, TLS or power failure preserves the recovery reference. Recovery does not re-submit a payment.
- Customer card PIN is four digits. Merchant send PIN is six digits, with existing legacy verification compatibility. No PIN is written to the checkout journal.
- Hold acceptance is not generic `pending`. Unpaid creation never triggers a forward or phantom balance.
- Abandoned wraps close only after live incoming state and absence of outgoing liability are corroborated. Short provider pages alone cannot prove absence.
- QR and NFC send compete for the same durable checkout. A successful NFC request cannot leave a second spendable QR authorization.
- Core holdWrap, feeEngine, walletSource, nwc and boltcard payment logic is not refactored or rewritten.

## Device and dependency use

ILI9341_2 on HSPI and XPT2046 on separate VSPI remain unchanged. NFC remains on the existing GPIO22/27 wiring. The dual-core CPU separates latency-sensitive display/touch from blocking I/O. No framebuffer, runtime plugin loader, new cloud service, or external UI dependency is added.

Platform and library versions are pinned to the already used versions. PN532 is vendored with license and provenance. Its local changes are memory/response bounds, not invented RF register settings. QR capacity is checked before entering the existing encoder.

## Reproducible acceptance commands

```sh
npm run typecheck
npm run build
npm test
# DATABASE_URL must target a local openln_qa_* scratch database, never production.
node --experimental-test-module-mocks --test tests/ric-payments.integration.mjs tests/ric-reconcile.integration.mjs tests/ric-wrap-engine.integration.mjs tests/ric-invoice-route.integration.mjs
node --test tests/ric-management.integration.mjs tests/ric-device-scope.integration.mjs tests/ric-auth.integration.mjs tests/send-pin.integration.mjs
cd firmware/esp32-pos
~/.venv-pio/bin/pio run -e esp32dev
```

Host tests compile the actual screen code and installed bitmap fonts. Main-loop tests compile all of main.cpp with explicit hardware/wallet boundaries and deny real network calls. Sanitizers exercise real PN532 method bodies and transport parsing. These are not substitutes for physical RF, touch, scan and power-cut checks.

## Release gate

Edit and commit on gateway main, `scripts/ship.sh dev`, verify dev, then `scripts/ship.sh promote`. Generate factory and app-only OTA files with `scripts/package-ric-firmware.py`; their SHA-256, sizes, board and partition metadata must agree.

The A/B layout is unchanged: app0 0x20000, app1 0x200000, otadata 0x16000. USB recovery preserves NVS and uses app-only image on the verified active slot. Never treat a merged factory image as an OTA payload.

## Limits, not certifications

This board is not a certified tamper-resistant payment terminal. CA-verified TLS, bounded parsing, scoped device credentials and digest-checked OTA protect important network boundaries, but flash remains readable to a physically present attacker. There is no deployed secure-boot/flash-encryption manufacturing process, signed offline release root, or automatic bootloader rollback. Enabling eFuses is irreversible and requires a separate manufacturing and recovery decision, not a remote convenience patch.

Power quality, enclosure, cable strain relief, moisture/temperature protection and antenna mounting remain deployment requirements. Hardware tests must cover real card/PIN/QR/send, poor Wi-Fi, power loss after submission, and OTA interruption before describing the release as field-qualified.

References: [CYD hardware reference](https://github.com/witnessmenow/ESP32-Cheap-Yellow-Display), [ESP-IDF FreeRTOS](https://docs.espressif.com/projects/esp-idf/en/v4.4.7/esp32/api-reference/system/freertos.html), [NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md), [ESP32 Secure Boot v2](https://docs.espressif.com/projects/esp-idf/en/v4.4.7/esp32/security/secure-boot-v2.html).
