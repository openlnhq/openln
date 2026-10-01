#pragma once
#include <TFT_eSPI.h>
#include "../ui/Numpad.h"

class PinScreen {
public:
    // pinLength: 4 (card PIN, default) or 6 (merchant account PIN)
    static void draw(TFT_eSPI& tft, const String& cardUid, int pinLength = 4);
    static void update(TFT_eSPI& tft); // shake animation after wrong PIN

    // Returns 'C' (Cancel), 'O' (Confirm tapped with correct digits), or 0
    static char handleTouch(TFT_eSPI& tft, int tx, int ty);

    static String getPin();
    static void   clearPin();
    static void   setWrongPin(TFT_eSPI& tft);

    // Animated "machine" screen (Motion engine). Returns immediately; the
    // render task keeps it moving while the caller blocks on I/O.
    static void drawProcessing(TFT_eSPI& tft,
                               const char* title    = "Verifying",
                               const char* subtitle = "PIN...");

    // Confirming screen: shown after the PIN callback succeeds, while the poll
    // loop waits for invoice settlement. Replaces the QR so the cashier never
    // sees the payment screen a second time. Animated by the Motion engine.
    static void drawConfirming(TFT_eSPI& tft);
    static void updateConfirming(TFT_eSPI& tft);   // no-op, kept for API compatibility

private:
    static String _pin;
    static int    _pinLength;  // 4 (card) or 6 (merchant)
    static Numpad _numpad;
    static bool     _shaking;
    static uint32_t _shakeStart;
    static int      _shakePhase;

    // Layout (landscape 320x240):
    // Top bar (inline, y=2, h=36):
    //   left  zone x=0..80:   "Enter PIN" label
    //   centre zone x=80..240: 4 PIN dots (shake-animated)
    //   right zone x=240..320: Cancel button
    // Separator: y=40
    // Numpad: y=42, KEY_H=49, 4 rows=196px -> ends y=238
    // Confirm occupies numpad bottom-left cell (row 3, col 0)
    static const int BAR_Y      = 2;
    static const int BAR_H      = 36;
    static const int DOT_ZONE_X = 80;   // centre zone left edge
    static const int DOT_ZONE_W = 160;  // centre zone width
    static const int CANCEL_X   = 240;  // right zone left edge (touch + draw)
    static const int NUMPAD_Y   = 42;
    static const int NUMPAD_KH  = 49;   // 4 * 49 = 196 px, ends y=238

    static void drawDots(TFT_eSPI& tft, int offsetX = 0);
    static void drawConfirmKey(TFT_eSPI& tft);
};
