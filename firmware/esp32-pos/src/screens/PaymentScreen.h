#pragma once
#include <TFT_eSPI.h>
#include <Arduino.h>

class PaymentScreen {
public:
    // Call on state entry — draws the amount block, QR, NFC strip + Cancel button.
    // bolt11 must remain valid for the duration of this state.
    // fiatLabel is the typed amount + currency (e.g. "5.00 THB"); shown as the primary line.
    // ttlSec is the on-screen validity window (mirror main's waiting timeout) used
    // for the countdown; pass the same value each redraw of the same invoice.
    static void draw(TFT_eSPI& tft, const String& bolt11, long amountSats, const String& fiatLabel, int ttlSec);

    // Animate the NFC pulse ring — call each loop iteration
    static void update(TFT_eSPI& tft);

    // Switch the NFC strip to "Card detected — hold still!" so the user
    // knows not to remove the card while APDU reading is in progress.
    static void showCardDetected(TFT_eSPI& tft);

    // Returns true if Cancel was tapped
    static bool handleTouch(int tx, int ty);

private:
    static uint32_t _lastPulse;
    static int      _pulsePhase;

    // Invoice countdown (TTL) — the device has no synced wall-clock, so the
    // deadline is a millis()-based window set once per invoice (keyed on bolt11)
    // so PIN round-trips don't reset it. _ttlSec mirrors main's waiting timeout.
    static uint32_t _deadlineMs;
    static String   _timedBolt11;
    static int      _lastShownSec;
    static int      _ttlSec;

    static int  remainingSec(uint32_t now);
    static void drawAmountHeader(TFT_eSPI& tft, long amountSats, const String& fiatLabel);
    static void drawTimer(TFT_eSPI& tft, int rem);
    static void drawQR(TFT_eSPI& tft, const String& bolt11, int cx, int cy, int boxPx);
    static void drawNfcHint(TFT_eSPI& tft, int phase);
};
