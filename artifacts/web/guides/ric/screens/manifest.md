# RIC display screens, frame by frame (KB image set)

Rendered from the RIC firmware's own animation code with the in-repo host preview
tool. No device and no browser were used; the renderer is deterministic and
pixel-exact.

- Date: 2026-10-13
- Repo: `/root/.worktrees/openln-rizful` at `afadab5` (firmware 1.0.16)
- Display: 320x240 (ILI9341, landscape). Every PNG in this set is exactly
  320x240, native panel resolution.
- Renderer: `firmware/esp32-pos/tools/motion-preview/preview.cpp` (with
  `render.sh`), which compiles the real scene code `src/motion/Scenes.cpp` and
  runs it through the same banded 4-bit-palette framebuffer engine (`Fb4` +
  `Bands`) the device uses.

## What is here

- `screens/<scene>/frame-NN.png`: evenly spaced frames sampled across that
  scenario's animation (16 per scene for receive, connect, update; 12 for the
  rest).
- `screens/<scene>/still.png`: one representative still per scene, chosen to
  read well as a single image in a guide page (usually the final hold of a
  success screen, mid-animation for the looping ones).
- 11 scenarios, 144 frame PNGs + 11 stills, 155 files total.

| Scene | Frames kept | Frames rendered | Scenario length | Still shows |
|---|---|---|---|---|
| receive | 16 | 262 | 8.6 s | Payment received, 35 sats (final) |
| receive-big | 12 | 137 | 4.5 s | Payment received, 125,000 sats (final) |
| cel-recv | 12 | 73 | 2.4 s | Payment received, 35 sats (final) |
| cel-sent | 12 | 73 | 2.4 s | Payment sent, 2,100 sats (final) |
| send | 12 | 176 | 5.8 s | Payment sent, 2,100 sats (final) |
| stall | 12 | 91 | 3.0 s | Confirming payment, Reconnecting (mid) |
| card-issue | 12 | 170 | 5.6 s | Card issued, Ready for payments (final) |
| card-wipe | 12 | 182 | 6.0 s | Card wiped, Blank and ready to issue again (final) |
| provision | 12 | 146 | 4.8 s | BLE pairing beacon (mid) |
| connect | 16 | 213 | 7.0 s | Connecting to WiFi (join phase) |
| update | 16 | 223 | 7.3 s | Updating firmware, 72% (mid download) |

## Fidelity and conventions

- The renderer emits 30 fps frames (33 ms steps) through a simulated 320x240
  RGB565 panel; colors in the PNGs are the device's RGB565 values expanded to
  RGB24, so hues and banding match the panel.
- One cumulative scenario clock runs across the scenario's segments, advancing
  33 ms per frame. `frame-NN` is the NN-th sample, not animation frame number
  NN; each sample's clock time is listed per scene below (clock = 33 ms x dump
  index).
- The tool covers the animated Motion screens only. Static screens drawn
  directly with TFT_eSPI (amount/numpad, QR payment screen, PIN pads, settings
  menu, WiFi setup, error screen, Firmware & Updates page, card read result)
  are NOT covered and need a real device.
- These are renders, not photographs. Do not substitute the repo's marketing
  photography (`artifacts/web/media/ric-still.jpg` and friends) for screen
  references.
- Scenario text and amounts are sample values (35 / 2,100 / 125,000 sats,
  "RIC-7F3A", "Samui Beach Cafe", "v1.0.13 to v1.0.14"). A real device shows
  live values; layout and animation are identical.

## How to re-render (exact commands used)

All build outputs went to a scratch dir; nothing in the repo was modified.

```bash
FW=/root/.worktrees/openln-rizful/firmware/esp32-pos
TFT=/root/bitpos-src/artifacts/esp32-pos/.pio/libdeps/esp32dev/TFT_eSPI
FFMPEG=/root/.hermes/tools/ffmpeg-9.0.1-linux-x64/bin/ffmpeg
S=/root/.hermes/cache/scratch/ric-kb-build

# 1. Build the preview renderer (once). g++ (system) + TFT_eSPI only for Fonts/.
g++ -std=c++17 -O2 -I "$FW/src" -I "$TFT" \
    "$FW/tools/motion-preview/preview.cpp" "$FW/src/motion/Scenes.cpp" -o "$S/bin/ric-preview"

# 2. Dump every frame of a scenario as a 320x240 PNG. Repeat for each scenario:
#    receive receive-big cel-recv cel-sent send stall card-issue card-wipe provision connect update
"$S/bin/ric-preview" receive | $FFMPEG -loglevel error -y -f rawvideo -pix_fmt rgb24 \
    -s 320x240 -r 30 -i - "$S/dump/receive/all-%04d.png"

# 3. Sample evenly spaced frames -> screens/<scene>/frame-NN.png
#    n = 16 samples for receive/connect/update (>= 200 frames dumped), 12 otherwise;
#    sample indices idx(i) = round(i * (N-1) / (n-1)) for i = 0..n-1, sorted
#    (evenly spaced, includes the first and last rendered frame).

# 4. Representative still per scenario, cumulative ms on the scenario clock
#    (still clock for each scene is listed below):
"$S/bin/ric-preview" receive --still 8052 > "$S/stills/receive.ppm"
$FFMPEG -loglevel error -y -i "$S/stills/receive.ppm" "$S/stills/receive-still.png"
```

The `--still` path was cross-checked against the frame dumps: each still is
byte-identical to the dumped frame at the same clock.

## Scenes

### receive: payment received, full flow (16 frames)

What a merchant sees: the payment machine on black: "Processing payment / One
moment" with orange gears turning (lightning bolt hub), then "Confirming
payment / Settling over Lightning" with the amount ("35 sats") at the bottom
and bitcoin coins being pulled into the machine, then "Finishing up. Do not tap
again." while the wallet commits, and finally the full-screen green success:
white disc with a green check, "35 sats", "Payment received" with the amount
counting up.

When on device: after a customer taps an openLN card (with or without PIN) and
the Lightning invoice settles. `MotionUi::processing("Processing payment", ...,
Mood::Receive)` is at `main.cpp:850`; confirming/stalled/committed variants at
`main.cpp:632/759/777`; the finale is the celebrate scene drawn by
`ResultScreen`. Preview samples 35 sats; the device shows the real invoice
amount.

- Frames: 262 rendered (0 to 8613 ms), 16 kept at clocks (ms):
  0, 561, 1155, 1716, 2310, 2871, 3432, 4026, 4587, 5181, 5742, 6303, 6897,
  7458, 8052, 8613. Segment layout: processing 0 to 1000, confirming 1000 to
  4000, finishing up 4000 to 5400, celebration 5400 to 8600.
- Still: `receive/still.png`, final hold at 8052 ms, "35 sats / Payment
  received".
- Wording note: the preview's committed segment uses the title "Confirming
  payment" (`preview.cpp:106`); the current firmware `MotionUi::confirming(...,
  committed=true)` sets the title "Payment received" with the same "Finishing
  up. Do not tap again." subtitle (`MotionUi.cpp:38`). Only that title differs
  from the frames.

### receive-big: large payment, 125,000 sats (12 frames)

What a merchant sees: the same confirming flow with a five-figure amount,
"Confirming payment / Settling over Lightning / 125,000 sats" (thousands comma
drawn manually), then the received celebration with the amount counting up to
"125,000 sats / Payment received".

When on device: any sale with a larger amount; this scenario demonstrates the
thousands separator and the count-up.

- Frames: 137 rendered (0 to 4488 ms), 12 kept at clocks (ms):
  0, 396, 825, 1221, 1617, 2046, 2442, 2871, 3267, 3663, 4092, 4488.
  Segment layout: confirming 0 to 1500, celebration 1500 to 4500. The frame at
  3267 ms catches the count-up mid-flight at "108,078 sats".
- Still: `receive-big/still.png`, final hold at 4092 ms.

### cel-recv: payment received celebration, standalone (12 frames)

What a merchant sees: the celebration on its own. Dark screen, orange magnet
core, bitcoin coins pulled in; flash at 820 ms; green flood and shock ring; then
the green success hold: check badge, "35 sats", "Payment received".

When on device: `MotionUi::celebrate(false, sats)` from the success result
screen after a received payment. Scene duration 1750 ms, then the final frame
holds until replaced.

- Frames: 73 rendered (0 to 2376 ms), 12 kept at clocks (ms):
  0, 231, 429, 660, 858, 1089, 1287, 1518, 1716, 1947, 2145, 2376.
- Still: `cel-recv/still.png`, final hold at 2145 ms. Pixel-identical to
  `receive/still.png` by design (same celebration, same amount; the receive
  scenario just includes the earlier phases).

### cel-sent: payment sent celebration, standalone (12 frames)

What a merchant sees: coins blasted away from the center of the dark screen
(flash at 560 ms, earlier than received), green flood, then the green hold:
check badge, "2,100 sats", "Payment sent".

When on device: `MotionUi::celebrate(true, sats)` after a successful send.
Scene duration 1490 ms, then the final frame holds.

- Frames: 73 rendered (0 to 2376 ms), 12 kept at clocks (ms):
  0, 231, 429, 660, 858, 1089, 1287, 1518, 1716, 1947, 2145, 2376.
- Still: `cel-sent/still.png`, final hold at 2000 ms. Pixel-identical to
  `send/still.png` (same celebration, same amount).

### send: sending payment, full flow (12 frames)

What a merchant sees: "Sending payment / To the tapped card / 2,100 sats" with
the gears running (send mood feeds coins into the machine), then the sent
celebration: blast out, green flood, "2,100 sats / Payment sent".

When on device: the send/withdraw flow, when the merchant taps an openLN card
to pay out to it (`main.cpp:1045`).

- Frames: 176 rendered (0 to 5775 ms), 12 kept at clocks (ms):
  0, 528, 1056, 1584, 2112, 2640, 3135, 3663, 4191, 4719, 5247, 5775.
  Segment layout: sending 0 to 2600, celebration 2600 to 5800.
- Still: `send/still.png`, final hold at 4800 ms.

### stall: reconnecting while confirming (12 frames)

What a merchant sees: "Confirming payment / Reconnecting..." with the gears
dimmed to muted brown (stall ratchet, slower motion) and the amount ("35 sats")
still at the bottom. No Cancel button in this state.

When on device: while the invoice is settling but the connection hiccups
(`MotionUi::confirming(sats, committed, stalled=true)`, `main.cpp:759`), or the
"Reconnecting / WiFi lost, invoice kept" variant at `main.cpp:1551`.

- Frames: 91 rendered (0 to 2970 ms), 12 kept at clocks (ms):
  0, 264, 528, 825, 1089, 1353, 1617, 1881, 2145, 2442, 2706, 2970.
- Still: `stall/still.png`, mid-animation at 1600 ms.

### card-issue: writing a new card (12 frames)

What a merchant sees: "Writing card / Keep the card on the reader" with an
openLN card graphic, orange NFC emission dots, and a 3-step tracker (Write data,
Authenticate, Secure card) that turns each step green as it completes. Then the
finale: the card graphic with a green check badge, "Card issued / Ready for
payments".

When on device: the Issue Card flow from the settings menu (tap a blank card;
`main.cpp:1149-1217`). Step labels come from the NFC writer via `CardSteps.h`.

- Frames: 170 rendered (0 to 5577 ms), 12 kept at clocks (ms):
  0, 495, 1023, 1518, 2013, 2541, 3036, 3564, 4059, 4554, 5082, 5577.
  Segment layout: writing 0 to 2800 (preview advances a step every 800 ms),
  finale 2800 to 5600.
- Still: `card-issue/still.png`, final hold at 5100 ms.

### card-wipe: wiping a card (12 frames)

What a merchant sees: "Wiping card / Keep the card on the reader" with the card
graphic and a 4-step tracker (Read, Authenticate, Reset, Erase); a red erase
beam crosses the card as the last step runs. Then the finale: a blank grey card
with a green check badge, "Card wiped / Blank and ready to issue again".

When on device: the Wipe Card flow from the settings menu (`main.cpp:1167`).
The wipe finale waits for the erase beam to exit before the badge pops (beat
260 ms).

- Frames: 182 rendered (0 to 5973 ms), 12 kept at clocks (ms):
  0, 528, 1089, 1617, 2178, 2706, 3267, 3795, 4356, 4884, 5445, 5973.
  Segment layout: wiping 0 to 3200 (step every 700 ms), finale 3200 to 6000.
- Still: `card-wipe/still.png`, final hold at 5500 ms.

### provision: BLE pairing beacon (12 frames)

What a merchant sees: a Bluetooth rune inside pulsing orange radar rings, the
device name large ("RIC-7F3A" in the preview), and "Open openln.com/app, Link
device, and choose this name".

When on device: whenever the unit is not yet linked (first boot, or after the
WiFi credentials were wiped from the connect screen). The name shown is the
unit's real BLE name (`ProvisionService::deviceName()`).

- Frames: 146 rendered (0 to 4785 ms), 12 kept at clocks (ms):
  0, 429, 858, 1320, 1749, 2178, 2607, 3036, 3465, 3927, 4356, 4785.
  Runs until the device is linked.
- Still: `provision/still.png`, mid-radar at 2600 ms.

### connect: WiFi join, linking, retry (16 frames)

What a merchant sees, in three phases: "Connecting to WiFi" with the network
name and a red Cancel button; "Linking to openLN / Secure connection" with the
WiFi arcs sparking; and "Reconnecting to openLN / Saved settings kept.
Retrying." with dimmed arcs.

When on device: join at boot and after WiFi loss (`main.cpp:247`); the link
phase runs through the TLS handshake and auth (`main.cpp:286`); retry when the
server is unreachable (`main.cpp:292`), plus a "Device link rejected / Check
this device in your account" variant when the token is rejected.

- Frames: 213 rendered (0 to 6996 ms), 16 kept at clocks (ms):
  0, 462, 924, 1386, 1881, 2343, 2805, 3267, 3729, 4191, 4653, 5115, 5610,
  6072, 6534, 6996. Segment layout: join 0 to 2600, link 2600 to 4800, retry
  4800 to 7000.
- Still: `connect/still.png`, join phase at 1650 ms.

### update: firmware update (16 frames)

What a merchant sees, in three phases: "Checking updates / Secure connection to
openLN" with a spinning orange tick ring; "Updating firmware / v1.0.13 to
v1.0.14" with the progress ring and percent and a "Do not disconnect power"
footer with a lightning bolt; and "Update verified / Restarting device" with a
green check ring.

When on device: OTA via `OTAManager` (`src/api/OTAManager.h`). The download and
verified screens appear on any successful check (automatic at boot and roughly
every 15 minutes, or manual from the Firmware & Updates page); the checking
screen appears on a manual check. Version strings in the frames are the
preview's sample values; a real unit shows installed to target.

- Frames: 223 rendered (0 to 7326 ms), 16 kept at clocks (ms):
  0, 495, 990, 1452, 1947, 2442, 2937, 3432, 3894, 4389, 4884, 5379, 5874,
  6336, 6831, 7326. Segment layout: checking 0 to 1600, download 1600 to 5800
  (preview percent = (t-1600) * 100 / 3800), verified 5800 to 7300. Note the
  device renders this scene at 50 ms per frame while the preview samples at
  33 ms steps; layout and percent curve are identical.
- Still: `update/still.png`, download at 4356 ms ("72%").

## Notes

- If the scene code changes, re-render from the same commit as the shipped
  firmware so the KB images match what merchants see. Cite `afadab5` /
  firmware 1.0.16 for this pass.
- Sampling interval per scene: about 550 to 750 ms between kept frames; each
  scene's full frame dump can be regenerated with the commands above (scratch
  dumps are not kept).
- A frame sampled mid-flash or mid count-up can look unusual in isolation (for
  example "108,078 sats" in receive-big, "33 sats" in receive); that is real
  animation, not a glitch.
- Embedding tip: stills are 320x240; they upscale cleanly at 2x with
  nearest-neighbour scaling for guide pages.
