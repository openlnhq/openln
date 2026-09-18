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
    // Change status without re-encoding or repainting the QR.
    static void setStage(TFT_eSPI& tft, const String& label, bool canCancel = true);
    static int remainingSec(uint32_t now);

    // Draw (or re-enable) the Cancel button in its fixed zone. Also used by the
    // "creating invoice" screen so cancel hit-testing is shared.
    static void drawCancelButton(TFT_eSPI& tft);

    // Returns true if Cancel was tapped
    static bool handleTouch(int tx, int ty);

private:
    static uint32_t _lastPulse;
    static int      _pulsePhase;

    // Rollover-safe monotonic deadline retained when the same invoice is redrawn.
    static uint32_t _startedMs;
    static String _stage;
    static bool _canCancel;
    static String   _timedBolt11;
    static int      _lastShownSec;
    static int      _ttlSec;

    static void drawAmountHeader(TFT_eSPI& tft, long amountSats, const String& fiatLabel);
    static void drawTimer(TFT_eSPI& tft, int rem);
    static void drawQR(TFT_eSPI& tft, const String& bolt11, int cx, int cy, int boxPx);
    static void drawNfcHint(TFT_eSPI& tft, int phase);
};
