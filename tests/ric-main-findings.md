# Actual-main host verification

**18/18 current-main scenarios PASS.**

- `node --test tests/ric-main.test.mjs`: exit 0, 18 pass, 0 fail, 0 skipped.
- `RIC_MAIN_REVISION=159cf93 node --test tests/ric-main.test.mjs`: expected exit 1,
  1 pass / 17 RED regressions. Includes an exercised duplicate callback after
  timeout/retry; the legacy settlement-control case passes.
- Current verified source SHA256:
  `0f0e228d4922fb74e1b88e62cf784187620f01ad56640a6bd49b7500f96a3b6f`.
  Live canonical main matched this hash at final verification. Compiler log empty.
- Current and baseline reports: `tests/ric-main-shim/evidence/{current,baseline}.json`
  and corresponding `.tap` files. Design: `tests/ric-main-shim/README.md`.

Initial new-main tests found boot recovery still fetched price before querying
its saved checkout. Parent's subsequent source revision fixed the ordering;
all four boot variants now pass. The added active-NFC Cancel test also passes:
actual touch handling requests cancellation while detection is held, then
ignores the late detection result and excludes maintenance until take().

Tests cover gated UI/IO, callback at-most-once, WiFi hash retention, both journal
kinds and dispatch flags, 600-second receive expiration (QR and card), typed PIN
rejection/new challenge following server unknown, PIN-like timeout ambiguity,
shared QR/NFC k1, commit-before-exposure/dispatch, and cancellation ownership.

No production files were changed by this test agent. No commits, hardware,
serial, live HTTP, wallets, or real payment operations. Every scenario has zero
transport attempts; a separate canary verifies all four transport deny wrappers.
Actual main and journal codec are compiled, with explicit hardware/API/UI/worker
boundaries. This does not replace real FreeRTOS/TLS/NFC or server integration tests.
