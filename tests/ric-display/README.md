# RIC host display verification

This harness compiles the real classic CYD screen translation units:

- `firmware/esp32-pos/src/screens/PaymentScreen.cpp`
- `firmware/esp32-pos/src/screens/PinScreen.cpp`
- `firmware/esp32-pos/src/ui/Numpad.cpp`

It links the installed `QRCode/src/qrcode.c` as C. It does not edit production sources, talk to a device, make network requests, or use real payable invoices.

## Run

From `/home/kongzi/openln`:

```sh
node --test tests/ric-display.test.mjs
python3 tests/ric-display/render.py
```

The renderer defaults to `/home/kongzi/.hermes/ric-review/render`. Open `index.html` there for the gallery. `report.json` contains behavior results, geometry, exact compiler commands, source/dependency hashes, and binary paths. Each scene has PNG, PPM, pixel-path SVG, and a JSON primitive/text trace.

```sh
python3 tests/ric-display/render.py --out /home/kongzi/.hermes/ric-review/render/review-name
RIC_DISPLAY_OUT=/home/kongzi/.hermes/ric-review/render/review-name node --test tests/ric-display.test.mjs
```

A renderer exit code of zero means artifacts were produced, not that acceptance tests passed. Run the Node tests to enforce the assertions. The gallery/report enumerate the current run; a reused output directory can also contain old, unlinked frames.

Prerequisites: Python 3.9+, Node with `node:test`, `gcc`, `g++` with C++17/filesystem support, and the firmware's already-installed PlatformIO dependencies under `firmware/esp32-pos/.pio/libdeps/esp32dev`. The renderer accepts `--deps PATH`. Missing fonts/QR dependencies are hard failures, never substituted.

## Fidelity and instrumentation

The renderer imports selected software raster routines from the installed `TFT_eSPI.cpp` at build time, retaining the dependency license and method hashes. Font 2 uses the installed `Font16` bitmap; font 4 uses the installed `Font32rle` data. Font 6 resources are also loaded for existing theme compatibility. No desktop fonts or hand-drawn screen replacements are used. Independent bitmap/RLE decoders compare the rendered `0` glyph against both font 2 and font 4 resource bytes.

Host adapters replace Arduino `String`, the clock, and TFT bus writes. `millis()` is explicitly `uint32_t`, not the host's wider `unsigned long`. The imported font reader's flash address uses `uintptr_t` for 64-bit host pointers. Transaction boundaries are host no-ops. Synthetic sats include `INT32_MAX`, even though host `long` is wider than ESP32 `long`.

Linker wrappers observe the unchanged C encoder and its real `qrcode_getModule` queries. A queried module's encoded coordinates are associated with the following TFT fill. This works with both white/black module fills and dark-only painting on a white background. QR origin is not guessed from unrelated black rectangles. Every data pixel is checked against the encoder output; every pixel of the four-module white quiet zone, including all four corners, is checked separately.

Text traces include measured bounds, actual ink bounds, font, color, draw time, and retained foreground-pixel counts. Single-draw layout tests detect clipping, text overlap, amount erasure, and QR intrusion. Traces retain draw history; layout diagnostics for multi-update snapshots can therefore include intentionally replaced status/timer labels. Use the single-draw acceptance cases for automatic no-overlap assertions.

## Behavior coverage

- Countdown display across 32-bit `millis()` rollover, using text emitted by the real screen.
- Original deadline retained on same-invoice redraw, reset for a new invoice.
- Every requested `delay()` recorded; processing and confirming must not request a delay.
- Real PIN/Numpad touch handling for 4- and 6-digit completion.
- Small, exactly 14-character (`999,999.99 THB`), and 16-character (`9,999,999.99 THB`) fiat labels, including full currency text and `2,147,483,647 sats`.
- Fiat glyph height must lead the smaller sats/timer hierarchy, without erased ink.
- QR data, quiet zone, geometry, and robustness against an unrelated dark pixel outside the encoded grid.
- A 1050-character synthetic payload, isolated in a child process so an encoder crash does not discard all other evidence.

The 1050-character working-tree render selects version 19 and currently uses one-pixel modules. This is a recorded limitation for physical camera-scan/readability testing, not scan proof.

## Reproduce RED without checking out or editing source

```sh
RIC_DISPLAY_REVISION=159cf937f070c8bc98d37821c9aae7081a0707b0 \
RIC_DISPLAY_OUT=/home/kongzi/.hermes/ric-review/render/baseline-check \
node --test tests/ric-display.test.mjs
```

`--revision` uses `git archive` into an ignored build directory. It does not change the working tree or interrupt concurrent firmware work. Reachable source/dependency hashes must remain stable during compilation.

Evidence under `evidence/`:

- `pre-change.tap` and `pre-change.json`: original eight-test RED run, four failures. Rollover displayed zero initially; processing requested three 140 ms delays; the QR quiet zone contained 1328 non-white pixels; timer painting erased part of the max-sats line.
- `pre-change-current.tap`: extended suite against the same original commit. Six failures also include the dense QR crash and missing monetary font hierarchy.
- `working-tree.tap` and `verification.json`: commands, totals, and results after the parent agent's UI changes.
- `qr-overflow.log` and `qr-overflow.json`: standalone installed-encoder AddressSanitizer evidence. Version 14 with 1050 alphanumeric characters overflows its dynamic stack buffer; version 20 with that payload returns successfully.

Standalone encoder reproduction:

```sh
gcc -std=c99 -g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer \
  -I firmware/esp32-pos/.pio/libdeps/esp32dev/QRCode/src \
  tests/ric-display/qr-overflow.c \
  firmware/esp32-pos/.pio/libdeps/esp32dev/QRCode/src/qrcode.c \
  -o tests/ric-display/.build/qr-overflow-asan
ASAN_OPTIONS=detect_leaks=0 tests/ric-display/.build/qr-overflow-asan 14 1050
ASAN_OPTIONS=detect_leaks=0 tests/ric-display/.build/qr-overflow-asan 20 1050
```

## Verification boundary

These are real screen-code host rasters, not screenshots read from the physical TFT framebuffer. They do not establish SPI/display timing, physical contrast, touch calibration, NFC/network/worker behavior, real BOLT11 payment validity, or camera-scan reliability. No firmware build/flash, device reset, payment, live deployment, or git commit is performed by this harness.
