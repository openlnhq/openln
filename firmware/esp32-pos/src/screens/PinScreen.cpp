#include "PinScreen.h"
#include "../motion/Motion.h"
#include "../motion/MotionUi.h"
#include "../ui/Theme.h"

String   PinScreen::_pin;
int      PinScreen::_pinLength = 4;
Numpad   PinScreen::_numpad;
bool     PinScreen::_shaking       = false;
uint32_t PinScreen::_shakeStart    = 0;
int      PinScreen::_shakePhase    = 0;

void PinScreen::draw(TFT_eSPI& tft, const String& cardUid, int pinLength) {
    (void)cardUid;
    _pin       = "";
    _pinLength = pinLength;
    _shaking   = false;

    Motion::stop(); tft.fillScreen(COL_BG);

    // ── Top bar: [Enter PIN]  [● ● ● ●]  [Cancel] ────────────────────────
    // "Enter PIN" label — left zone
    tft.setTextColor(COL_MUTED, COL_BG);
    tft.setTextDatum(ML_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.drawString("Enter PIN", 6, BAR_Y + BAR_H / 2);

    // Cancel button — right zone
    int cbX = CANCEL_X + 4;
    int cbY = BAR_Y + 2;
    int cbW = SCREEN_W - CANCEL_X - 8;
    int cbH = BAR_H - 4;
    tft.fillRoundRect(cbX, cbY, cbW, cbH, 5, COL_CARD);
    tft.drawRoundRect(cbX, cbY, cbW, cbH, 5, COL_BORDER);
    tft.setTextColor(COL_MUTED, COL_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString("Cancel", cbX + cbW / 2, cbY + cbH / 2);

    // Separator
    tft.drawFastHLine(0, BAR_Y + BAR_H + 2, SCREEN_W, COL_BORDER);

    // PIN dots — centre zone
    drawDots(tft, 0);

    // Numpad (leaves bottom-left cell blank for Confirm)
    _numpad.draw(tft, NUMPAD_Y, NUMPAD_PIN, NUMPAD_KH);
    drawConfirmKey(tft);
}

void PinScreen::drawDots(TFT_eSPI& tft, int offsetX) {
    int filled = _pin.length();

    // Clear the centre dot zone only (leave label and Cancel intact)
    tft.fillRect(DOT_ZONE_X, BAR_Y, DOT_ZONE_W, BAR_H, COL_BG);

    // Dynamic number of dots based on _pinLength, evenly spaced inside the zone
    int n = _pinLength;
    int spacing = (n <= 4) ? 36 : 22;
    int startX = DOT_ZONE_X + (DOT_ZONE_W - (n - 1) * spacing) / 2;
    int cy     = BAR_Y + BAR_H / 2;

    for (int i = 0; i < n; i++) {
        int x = offsetX + startX + i * spacing;
        if (i < filled) {
            tft.fillCircle(x, cy, 10, COL_ACCENT);
        } else {
            tft.drawCircle(x, cy, 10, COL_MUTED);
        }
    }
}

void PinScreen::drawConfirmKey(TFT_eSPI& tft) {
    // Confirm occupies the numpad's bottom-left cell (row 3, col 0).
    // Geometry mirrors Numpad::drawKey so it blends with the grid.
    const int KEY_W = SCREEN_W / 3;  // 106 px
    const int GAP   = 2;
    int x = GAP;
    int y = NUMPAD_Y + 3 * NUMPAD_KH + GAP;
    int w = KEY_W - GAP * 2;          // 102 px
    int h = NUMPAD_KH - GAP * 2;      // 45 px

    bool enabled = (_pin.length() == _pinLength);
    uint16_t bg = enabled ? COL_ACCENT : COL_CARD;
    uint16_t fg = enabled ? TFT_WHITE  : COL_MUTED;

    tft.fillRoundRect(x, y, w, h, 6, bg);
    tft.drawRoundRect(x, y, w, h, 6, enabled ? COL_ACCENT : COL_BORDER);
    tft.setTextColor(fg, bg);
    tft.setTextDatum(MC_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.drawString("Confirm", x + w / 2, y + h / 2);
}

void PinScreen::setWrongPin(TFT_eSPI& tft) {
    _pin        = "";
    _shaking    = true;
    _shakeStart = millis();
    _shakePhase = 0;
    (void)tft;
}

void PinScreen::update(TFT_eSPI& tft) {
    if (!_shaking) return;
    uint32_t elapsed = millis() - _shakeStart;
    if (elapsed > 480) {
        _shaking = false;
        drawDots(tft, 0);
        drawConfirmKey(tft);
        return;
    }
    int phase = (int)(elapsed / 80) % 4;
    if (phase != _shakePhase) {
        _shakePhase = phase;
        int offset  = (phase == 0 || phase == 2) ? -8 : 8;
        drawDots(tft, offset);
    }
}

char PinScreen::handleTouch(TFT_eSPI& tft, int tx, int ty) {
    // ── Top bar ───────────────────────────────────────────────────────────
    if (ty >= BAR_Y && ty < BAR_Y + BAR_H) {
        if (tx >= CANCEL_X) return 'C';
        return 0;
    }

    // ── Confirm cell (numpad row 3, col 0) ────────────────────────────────
    const int KEY_W   = SCREEN_W / 3;
    int confRowY = NUMPAD_Y + 3 * NUMPAD_KH;
    if (tx < KEY_W && ty >= confRowY && ty < confRowY + NUMPAD_KH) {
        return (_pin.length() == _pinLength) ? 'O' : 0;
    }

    // ── Numpad (digits + backspace) ───────────────────────────────────────
    char key = _numpad.handleTouch(tx, ty, NUMPAD_Y, NUMPAD_PIN, NUMPAD_KH);
    if (!key) return 0;

    if (key == '\x08') {
        if (_pin.length() > 0) _pin.remove(_pin.length() - 1);
    } else if (key >= '0' && key <= '9') {
        if (_pin.length() < _pinLength) {
            _pin += key;
            if (_pin.length() == _pinLength) {
                // Auto-confirm on final digit — standard pattern on payment terminals
                // and phone unlock screens. Saves the customer an extra tap.
                drawDots(tft, 0);   // show all dots filled before transitioning
                return 'O';
            }
        }
    }

    drawDots(tft, 0);
    drawConfirmKey(tft);
    return 0;
}

String PinScreen::getPin()   { return _pin; }
void   PinScreen::clearPin() { _pin = ""; }

// Processing / confirming screens are animated by the Motion engine (gears
// crunching lightning, see motion/Scenes.cpp). The render task keeps them
// moving while the main loop blocks on network I/O, so updateConfirming() has
// nothing left to do and stays only for API compatibility.
void PinScreen::drawConfirming(TFT_eSPI& tft) {
    (void)tft;
    MotionUi::confirming(0, false);
}

void PinScreen::updateConfirming(TFT_eSPI& tft) { (void)tft; }

// Network progress is indeterminate, never a made-up completion percentage.
void PinScreen::drawProcessing(TFT_eSPI& tft, const char* title, const char* subtitle) {
    (void)tft;
    MotionUi::processing(title, subtitle, Scenes::Mood::Work);
}
