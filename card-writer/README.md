# openLN card writer

Write and wipe NTAG424 DNA Bolt Cards straight from a web page. No Play Store
app, no Android phone required.

The card cryptography that customers already trust (same keys, same SUN scheme,
same bytes) runs in the browser. A tiny local bridge gives the browser the one
thing it cannot do by itself: raw APDU access to the USB NFC reader.

```
  web app  ───  bridge  ───  USB NFC reader  ───  NTAG424 card
  (this UI)     (local)      (ACR122U, …)
       │
       └── extension or local HTTP, your choice
```

## Why a bridge (the 2026 browser NFC reality check)

Chrome's built-in NFC surface, checked again in September 2026:

| capability | status | usable for NTAG424 key programming? |
| --- | --- | --- |
| Web NFC (`NDEFReader`) | Android only, NDEF records only | no, no APDU, no desktop |
| WebUSB (CCID readers) | smart card interface class `0x0B` is a protected class | no, `claimInterface` refused |
| Web Serial | Android Chrome 148+ for USB serial readers | partial, Android only |
| Web Smart Card API | ChromeOS M143+, Isolated Web Apps only | not on desktop yet |

So the browser cannot speak PC/SC directly, anywhere, today. Hence this
bridge: a small local process that any web page (your own openLN webapp
included) can reach through a Chrome extension or a local HTTP endpoint, and
that does exactly one thing: forward APDU exchanges to the reader and back.

## What is here

```
engine/    card cryptography + protocol, plain ES modules, zero dependencies
           ntag424.js   NTAG424 DNA secure messaging (auth, keys, SDM, reads)
           ndef.js      NDEF + SDM builders, byte-identical to the server
           boltcard.js  high-level write / wipe / read / tap-verify flows
bridge/    local transport
           openln-cardbridge.py   Chrome native messaging + HTTP API + web UI host
           cardsim.py             strict NTAG424 simulator (no hardware needed)
web/       the card writer UI (served by the bridge)
extension/ Chrome extension (MV3) that exposes window.openlnBridge to pages
tools/     stable extension key (the extension id never changes)
tests/     vector tests, full flow tests, oracle diff vs the production app
```

## Quick start

The same page is served by openLN itself at `/card-writer` (e.g.
`https://dev.openln.com/card-writer`). With the extension installed it drives
the reader directly; without it, start the bridge below and the page finds it
on `127.0.0.1`.

### 1. Play without hardware (2 minutes)

```bash
python3 bridge/openln-cardbridge.py --http --sim
# open http://127.0.0.1:17777  →  Write card  →  Manual keys  →  Write
```

Every step runs against a strict chip simulation: NDEF writes, SDM settings,
key changes with CRC checks, taps. This is the whole flow with zero hardware.

### 2. With a real reader

```bash
python3 -m pip install pyscard      # linux also: sudo apt install pcscd
python3 bridge/openln-cardbridge.py --http
# plug in the reader, open http://127.0.0.1:17777
```

Any PC/SC reader works: ACR122U, ACR1252U, SCL3711, PN532 kits with CCID
firmware, and so on. The bridge picks the first one; use `--reader <name>` to
choose another.

### 3. The full setup (extension, for use inside the openLN webapp)

```bash
./install.sh        # registers the native messaging host (linux / macOS)
```

then load the extension: `chrome://extensions` → Developer mode → Load
unpacked → this repo's `extension/` folder. The stable extension id is
`iikjoajfihdnhkeaglmidonioplochdg` (`tools/extension-id.txt`); the public key
is pinned in `extension/manifest.json`, so the id never changes.

With the extension installed, any page on an allowed origin (openln.com,
dev.openln.com, localhost, 127.0.0.1, file://) gets `window.openlnBridge`
and can drive the reader with no server running. On Windows, the HTTP mode is
the simplest path; `install-windows.ps1` registers the native host if you
want the extension route too.

## Using it with openLN

### In the merchant app (Cards tab)

Issue a card in the app, then press **Write to card** on the card itself: the
app loads the NTAG424 engine from `/card-writer/` and drives the reader through
the bridge. Wipe lives on the same screen (**Wipe card** → *Erase this card
now*). The "Set up your card" dialog right after issuing opens on **This
computer** with the same flow.

The first time, the app shows a one-time setup: download the reader helper for
your OS (`bridge/card-bridge-macos.command`, `card-bridge-windows.cmd`,
`card-bridge-linux.sh`), run it, keep its window open, press *Check again*.
The helper is the same `openln-cardbridge.py`, wrapped so a double-click is
all it takes.

The standalone writer below still exists for device-token and manual flows.

The writer speaks openLN natively:

* **Device token mode**: paste the 64 character device token into the UI
  (stored locally in your browser only). *Get next card* pulls from
  `GET /api/pos/next-provision` and writes exactly the bytes the server
  computed (`ndefFile`, `sdmSettings`). After a successful write, *Mark
  written* calls `POST /api/pos/mark-written/{cardId}`.
* **Provision link mode**: scan the QR in the openLN card setup screen,
  paste the link, write. Works without a device token.
* **Wipe**: *Fetch wipe keys* from `GET /api/pos/wipe-keys/{cardId}`, wipe
  the chip to factory keys (`40e0ee01ffff`), then *Mark wiped* via
  `POST /api/pos/mark-wiped/{cardId}`. The card shows as cancelled in openLN
  and can be programmed again.
* **Random UID (privacy)**: optional, off by default; the provision payload's
  `uid_privacy` flag switches it on when the server asks for it. Note it is
  irreversible for that chip.

All openLN API calls go through the bridge (`openln_api`), so the page origin
never matters and your device token never leaves your machine except toward
your own openLN server. Only `https://openln.com`, `https://dev.openln.com`
(and `www`) `/api/` paths are allowed by the forwarder.

## How a write works (byte-for-byte, on purpose)

1. NDEF written first, while the chip is still factory-open:
   `lnurlw://<domain>/card/<id>?p=<32 zeros>&c=<16 zeros>`
2. `AuthenticateEV2First` with the current k0 (factory default `00…00`)
3. SDM file settings applied (`40 00 E0 C1 FF 12 || piccOffset || macOffset || macOffset`, little-endian)
4. `GetCardUID` proves the session
5. Keys 1..4 changed (XOR + CRC32 NK), then key 0 last (the session dies with it)
6. Wipe reverses it: factory file settings, keys back to `00…00`, empty NDEF

These bytes are not a re-interpretation. The engine is diffed APDU-by-APDU,
including challenge-response crypto, against the production card-installer
engine that openLN cards are programmed with today, and re-verified against a
second, independent implementation (BTCPay Server's NTag424). See
`tests/oracle.test.mjs` and `tests/bridge-e2e.test.mjs` (JS ↔ Python cross
check).

## Server side

No server changes are needed. openLN already verifies SUN taps
(`core/money/boltcard.ts`), builds NDEF/SDM (`plugins/card-ndef.ts`) and
authorizes device tokens for `next-provision`, `wipe-keys`, `mark-written`,
`mark-wiped`.

## Tests

```bash
cd tests/oracle && npm install && cd ../ui && npm install && cd ../..   # deps for oracle + browser e2e
node --test "tests/*.test.mjs"
```

* vectors: AES-128 (FIPS-197), CMAC (NIST SP 800-38B), CRC vs the npm `crc`
  package, NXP MAC truncation, EV2 padding, NDEF/SDM offset math
* flow: write → tap verify → wipe → rewrite against the strict JS mock
* oracle: APDU stream diff vs the production card-installer engine (vendored
  under `tests/oracle/vendor`, MIT)
* bridge e2e: JS engine over HTTP vs the Python simulator, plus Chrome native
  messaging framing
* ui e2e (`tests/ui/ui.e2e.mjs`): drives the real page in headless Chromium
  against bridge + simulator (write, tap check, wipe)
* extension e2e (`tests/ui/ui-extension.e2e.mjs`): the full native-messaging
  path in headless Chromium (needs `./install.sh` first)
* app e2e (`tests/ui/app-write.e2e.mjs`): drives the merchant app itself in
  headless Chromium (`APP_BASE=… node tests/ui/app-write.e2e.mjs`): register →
  issue → write from the Cards tab → tap verify → wipe, asserting chip and
  server state

## Security notes

* The bridge binds `127.0.0.1` only. It holds no keys and stores nothing.
* Card keys travel from your openLN server to your browser to the chip. The
  bridge just forwards APDUs.
* CORS on the HTTP channel is allow-listed (openln.com, localhost, LAN dev
  origins). `--allow-origin <pattern>` adds more.
* The page↔bridge protocol exposes only: status, transceive, uid, sim
  controls, and the openLN API forwarder.

## Troubleshooting

| symptom | fix |
| --- | --- |
| `no bridge found` in the UI | start `python3 bridge/openln-cardbridge.py --http`, or install the extension |
| `pyscard unavailable` note | `python3 -m pip install pyscard` (linux: also `pcscd`) |
| `card communication failed` | card not on the reader, or another app (pcscd clients) holds it |
| write fails with `91AE` | wrong current k0; wipe the card first (factory keys) |
| write fails with `6982` | the chip's file is already locked; an NDEF lock or different key set; wipe or inspect with *Card info* |
| `91AD` on key change | a previous partial run left mid-state; re-run the wipe flow |
| Chrome extension listed but silent | check `chrome://extensions` errors, and that `install.sh` registered the host manifest for your browser profile |

## License and credits

The wire protocol and flow ordering were validated against
[lawalletio/card-installer](https://github.com/lawalletio/card-installer) (MIT)
and [BTCPay Server's NTag424 toolkit](https://github.com/btcpayserver/BTCPayServer.BoltCardTools).
This repo's code is original; the cryptographic contracts follow NXP's
NTAG424 DNA documentation (AN12196) and the openLN server conventions.
