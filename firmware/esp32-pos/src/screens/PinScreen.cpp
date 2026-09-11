#include "PinScreen.h"
#include "../ui/Theme.h"

String   PinScreen::_pin;
int      PinScreen::_pinLength = 4;
Numpad   PinScreen::_numpad;
bool     PinScreen::_shaking       = false;
uint32_t PinScreen::_shakeStart    = 0;
int      PinScreen::_shakePhase    = 0;
uint32_t PinScreen::_confirmAnimLast  = 0;
int      PinScreen::_confirmAnimFrame = 0;

void PinScreen::draw(TFT_eSPI& tft, const String& cardUid, int pinLength) {
    (void)cardUid;
    _pin       = "";
    _pinLength = pinLength;
    _shaking   = false;

    tft.fillScreen(COL_BG);

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

// ── Confirming animation (post-PIN callback, waiting for invoice settlement) ──
//
// Drawn once via drawConfirming(), then updateConfirming() is called every
// loop iteration and redraws only the dot row when the 450 ms frame period
// elapses.  No full-screen repaint → no flicker.
//
// Dot layout shared with drawProcessing(): same coordinates so the visual is
// consistent across both "processing" and "confirming" states.
static const int CONF_DOT_Y = 155;
static const int CONF_DOT_R = 11;
static const int CONF_GAP   = 46;   // centre-to-centre

void PinScreen::drawConfirming(TFT_eSPI& tft) {
    _confirmAnimFrame = 0;
    _confirmAnimLast  = 0;      // force immediate first draw in updateConfirming()

    tft.fillScreen(COL_BG);

    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(COL_TEXT, COL_BG);
    tft.setTextFont(FONT_SMALL);
    tft.drawString("Payment", SCREEN_W / 2, 78);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_MUTED, COL_BG);
    tft.drawString("Confirming...", SCREEN_W / 2, 114);

    // Draw initial frame immediately so screen is never blank
    updateConfirming(tft);
}

void PinScreen::updateConfirming(TFT_eSPI& tft) {
    if (millis() - _confirmAnimLast < 450) return;
    _confirmAnimLast  = millis();
    _confirmAnimFrame = (_confirmAnimFrame + 1) % 3;

    const int cx = SCREEN_W / 2;
    // Clear only the dot row — height = 2*(radius+bounce+margin)
    tft.fillRect(0, CONF_DOT_Y - CONF_DOT_R - 8, SCREEN_W,
                 (CONF_DOT_R + 8) * 2, COL_BG);

    for (int i = 0; i < 3; i++) {
        int  x   = cx + (i - 1) * CONF_GAP;
        bool lit = (i == _confirmAnimFrame);
        int  yOff = lit ? -5 : 0;
        if (lit) tft.fillCircle(x, CONF_DOT_Y + yOff, CONF_DOT_R, COL_ACCENT);
        else     tft.drawCircle(x, CONF_DOT_Y + yOff, CONF_DOT_R, COL_MUTED);
    }
}

// ── Processing animation ──────────────────────────────────────────────────────
// Shown immediately after the user taps Confirm so the screen doesn't appear
// frozen during the blocking HTTPS call (~1-4 s).
//
// Layout (320×240 landscape):
//   "Verifying"  — FONT_SMALL, white, y=72
//   "PIN..."     — FONT_SMALL, muted, y=108
//   3 bouncing dots — y≈155, accent colour, one lit per frame
//   Progress bar — y=193, sweeps from 20% → 80% over 3 frames
//
// Timing: 3 pre-HTTP frames × 140 ms = 420 ms of animation, then the last
// frame is held on-screen while the network call completes.
void PinScreen::drawProcessing(TFT_eSPI& tft,
                               const char* title,
                               const char* subtitle) {
    tft.fillScreen(COL_BG);

    // Title
    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(COL_TEXT, COL_BG);
    tft.setTextFont(FONT_SMALL);
    tft.drawString(title, SCREEN_W / 2, 72);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_MUTED, COL_BG);
    tft.drawString(subtitle, SCREEN_W / 2, 108);

    // 3-frame bounce: dot i lights up and jumps 4 px when it is frame % 3
    const int dotY  = 155;
    const int dotR  = 11;
    const int gap   = 46;           // centre-to-centre spacing
    const int cx    = SCREEN_W / 2;

    // Progress bar geometry
    const int barX   = 28;
    const int barY   = 193;
    const int barH   = 6;
    const int barMaxW = SCREEN_W - 56;

    for (int frame = 0; frame < 4; frame++) {
        // Clear dot row (extra margin for the bounce offset)
        tft.fillRect(0, dotY - dotR - 6, SCREEN_W, (dotR + 6) * 2 + 2, COL_BG);

        for (int i = 0; i < 3; i++) {
            int x      = cx + (i - 1) * gap;
            bool lit   = (i == frame % 3);
            int  yOff  = lit ? -5 : 0;          // bounce up when active
            if (lit) {
                tft.fillCircle(x, dotY + yOff, dotR, COL_ACCENT);
            } else {
                tft.drawCircle(x, dotY + yOff, dotR, COL_MUTED);
            }
        }

        // Progress bar: 20 % → 40 % → 60 % → 80 % (holds at 80 during HTTP)
        int fillW = barMaxW * (frame + 1) / 5;
        tft.fillRect(barX,          barY, barMaxW, barH, COL_CARD);
        tft.fillRect(barX,          barY, fillW,   barH, COL_ACCENT);
        tft.drawRect(barX - 1,      barY - 1, barMaxW + 2, barH + 2, COL_BORDER);

        if (frame < 3) delay(140);   // animate frames 0-2; frame 3 holds for HTTP call
    }
}
