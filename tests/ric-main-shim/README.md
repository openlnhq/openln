# Actual RIC main.cpp host regression harness

## Run

From the repository root, with Python 3, Node, and a C++17 `g++` available:

```sh
node --test tests/ric-main.test.mjs
RIC_MAIN_REVISION=159cf93 node --test tests/ric-main.test.mjs
```

The second command is intentionally RED. It reads Git objects without checking
out or changing the worktree. There are no installs, downloads, server calls,
credentials, or physical-device operations.

For a single scenario and its full trace:

```sh
python3 tests/ric-main-shim/run.py --scenario callback-timeout-once --out tests/ric-main-shim/evidence/single.json
```

`run.py` returns 0 when it successfully builds and produces a report, including
reports containing scenario failures. **The Node test runner is the CI gate**:
it returns 1 for failed scenarios. Compiler/canary failures return nonzero even
from `run.py`. `RIC_MAIN_OUT` selects a saved report for the Node command.

## What is actually compiled

`tests/ric-main.cpp` includes **every byte of the selected
`firmware/esp32-pos/src/main.cpp`** in namespace `ric_main`. The selected source
is copied without rewriting it to an isolated include site, so its quoted
hardware includes can resolve to explicit host boundaries. Setup, loop, state
transitions, callbacks, cancellation, scheduling, recovery, and housekeeping
are the real code. There is no reimplementation of checkout logic in the test.

The runner records the source SHA256, byte count, compiler, compile log, and
snapshot path. Current API declarations are compiled from the selected real
`BitposClient.h`. Conditional fixture definitions support its legacy and typed
APIs; this does not change any production source. Tests call actual handlers
and drive the actual loop with synthetic touch events and a uint32_t clock.
Each scenario runs in a fresh process, including function-static state.

## Explicit boundaries

- Arduino String/clock, SPI, TFT, touch, WiFi, watchdog, and buzzer are host
  boundaries. The String adapter is based on `ric-display/adapters/Arduino.h`,
  extended locally for main.cpp's `trim()` / `toFloat()` use. The original
  adapters are not modified.
- Screen methods are observers/input boundaries, **not rasterizers**. They
  record draw/update calls, stages, QR payload, countdown argument and touches.
  Pixel correctness is covered separately by `ric-display.test.mjs`.
- `RicIoWorker` is a deterministic borrowed-context/Ready/take scheduler shim.
  A gate keeps a submitted operation Running until the test releases it. It
  invokes the real main.cpp worker function with a worker-role marker. Loop
  I/O in liveness tests and worker-side display access throw immediately.
  This tests main's integration, **not real FreeRTOS scheduling or TLS timing**.
- The **real CheckoutJournal codec/CRC/validation is used**, backed by the
  existing `ric-checkout-journal-shim` Preferences/NVS model. Boot fixtures
  persist real encoded records and reboot the NVS model before actual setup.
  Baseline main never reads this journal; its missing recovery is a real RED.
- BitposClient definitions are explicit scripted test responses. The real API
  implementation, TLS/HTTP libraries, wallets, and payment transport are not
  linked. Fixtures use `.invalid` endpoints and deliberately non-payable
  invoice/QR strings. The test does not claim any live payment/network result.
- Linker wrappers deny socket/connect/sendto/getaddrinfo. Every build executes
  a separate canary proving all four wrappers deny calls. Every checkout
  scenario must report **zero network transport attempts**. These wrappers are
  defense in depth, not a general-purpose OS sandbox.

## Scenarios

| Scenario | Actual-main assertion |
| --- | --- |
| frozen-tls | UI updates and watchdog continue while a submitted status job is gated; no loop-thread I/O |
| frozen-nfc | UI updates and watchdog continue while a submitted NFC job is gated |
| callback-paid-only | Callback acceptance is not settlement; authenticated hash status produces success |
| callback-timeout-once | Timeout, repeated tap, cancel/retry/confirm gestures cannot resend or replace an unresolved payment |
| wifi-preserve-hash | WiFi loss/recovery resumes polling the original hash, without a replacement invoice/callback |
| boot-receive-unsent | Saved undispatched receive is query-only on boot |
| boot-receive-dispatched | Saved dispatched receive is query-only on boot |
| boot-withdraw-unsent | Saved undispatched withdrawal is query-only on boot |
| boot-withdraw-dispatched | Saved dispatched withdrawal is query-only on boot |
| receive-window-600 | Receive QR is given a 600-second presentation window |
| receive-expiry-qr | Local expiry and failed/ambiguous cancellation retain a possibly paid QR receive; late paid is recognized |
| receive-expiry-card | Expiry beyond the former grace period retains a possibly charged card receive; late paid is recognized |
| typed-pin-retry | PinRejected without a PIN-like error substring permits cancel/retap and a new k1 despite intervening server unknown |
| send-shared-k1 | QR creation, NFC send argument and journal use the same withdrawal key; only one create/send occurs |
| journal-before-expose | Real journal commit precedes QR display; dispatched marker precedes callback |
| maintenance-gate | Outstanding NFC ownership excludes OTA/hello/price/reinit maintenance |
| pin-timeout-not-rejection | A timeout containing the word PIN remains uncertain, not a safe PIN retry |
| cancel-while-detecting | Touch cancellation works during gated NFC detection; late completion cannot revive checkout or overlap maintenance |

Boot cases additionally verify no OTA/price maintenance before recovery and
journal clearing only after a confirmed paid result. QR/NFC same-key testing
checks the arguments and main state machine; it does not prove server-side
atomic payment dispatch (the server integration suite owns that boundary).

## Verified evidence

- `evidence/current.json` / `current.tap`: 18 pass, 0 fail; no compiler warnings.
- `evidence/baseline.json` / `baseline.tap`: 1 pass, 17 expected failures on
  `159cf93`. The passing settlement-control scenario demonstrates that the
  harness can also recognize correct legacy behavior.
- Verified current main SHA256:
  `0f0e228d4922fb74e1b88e62cf784187620f01ad56640a6bd49b7500f96a3b6f`.

Build snapshots/binaries are isolated under ignored `.build/`. Source hashes
in saved reports identify exactly what was tested while parent edits proceed.
This is host integration evidence only, not a PlatformIO build, actual TLS,
physical NFC, flash/serial, framebuffer rendering, or live-payment acceptance.
