#include "PaymentScreen.h"
#include "../ui/Theme.h"
#include <qrcode.h>

uint32_t PaymentScreen::_lastPulse    = 0;
int      PaymentScreen::_pulsePhase   = 0;
uint32_t PaymentScreen::_deadlineMs   = 0;
String   PaymentScreen::_timedBolt11  = "";
int      PaymentScreen::_lastShownSec = -1;
int      PaymentScreen::_ttlSec       = 60;

// The on-screen invoice window is governed by main.cpp's waiting timeout
// (INVOICE_TIMEOUT_MS), not the server's longer invoice expiry — the device
// returns to the amount screen when that elapses. The countdown mirrors it
// (passed in as ttlSec) so the timer hits 0:00 exactly when the screen gives up.
// The device has no NTP clock, so the deadline is purely millis()-based.

// Landscape 320x240 layout — amount + sats on one line, bigger QR, then a single
// bottom row: NFC hint on the LEFT, a trashcan (cancel) button on the RIGHT.
//   y=2..27:   amount line (fiat + sats side by side) | countdown top-right
//   QR:        cy=107, ~146px on a white rounded card → y≈28..186
//   bottom row: y=200..234 — "Tap a Bolt Card" (left) + trash button (right)
static const int AMT_CY    = 14;    // ML datum — amount baseline center
static const int QR_CY     = 107;
static const int QR_BOX    = 148;   // square budget for the QR (modules fill it)
static const int ROW_Y     = 200;   // top of the bottom row
static const int ROW_H     = 34;    // height of the bottom row / trash button
static const int ROW_CY    = ROW_Y + ROW_H / 2;     // vertical centre of the row
static const int TRASH_W   = 46;    // trash (cancel) button width
static const int TRASH_X   = SCREEN_W - 8 - TRASH_W; // right-aligned, 8px margin
static const int NFC_CY    = ROW_CY; // NFC hint shares the row, left-aligned
static const int NFC_CLEAR_W = TRASH_X - 4;          // hint redraw stops before the button

// Draw a small trashcan icon centred on (cx, cy) using primitives (no icon font).
static void drawTrashIcon(TFT_eSPI& tft, int cx, int cy, uint16_t color) {
    tft.fillRect(cx - 3, cy - 9, 6, 2, color);          // lid handle (small tab)
    tft.fillRect(cx - 8, cy - 7, 16, 2, color);         // lid bar
    tft.drawRect(cx - 6, cy - 3, 12, 12, color);        // can body outline
    tft.drawFastVLine(cx - 2, cy - 1, 8, color);        // rib
    tft.drawFastVLine(cx + 2, cy - 1, 8, color);        // rib
}

// Comma-group an integer for readability, e.g. 12345 -> "12,345".
static String groupDigits(long v) {
    String s = String(v);
    String out;
    int len = s.length();
    for (int i = 0; i < len; i++) {
        if (i > 0 && (len - i) % 3 == 0) out += ',';
        out += s[i];
    }
    return out;
}

int PaymentScreen::remainingSec(uint32_t now) {
    if (now >= _deadlineMs) return 0;
    uint32_t ms = _deadlineMs - now;
    int s = (int)((ms + 999) / 1000);   // ceil
    if (s > _ttlSec) s = _ttlSec;
    return s;
}

void PaymentScreen::draw(TFT_eSPI& tft, const String& bolt11, long amountSats, const String& fiatLabel, int ttlSec) {
    tft.fillScreen(COL_BG);

    // Start (or keep) the countdown for THIS invoice. A PIN round-trip re-draws
    // with the same bolt11, so the deadline is preserved instead of reset.
    if (bolt11 != _timedBolt11) {
        _timedBolt11 = bolt11;
        _ttlSec      = (ttlSec > 0) ? ttlSec : 60;
        _deadlineMs  = millis() + (uint32_t)_ttlSec * 1000UL;
    }
    _lastShownSec = -1;

    // Amount line — fiat + sats side by side
    drawAmountHeader(tft, amountSats, fiatLabel);

    // Countdown TTL — top-right corner
    drawTimer(tft, remainingSec(millis()));

    // QR code — centred on a clean white rounded card, as large as fits
    drawQR(tft, bolt11, SCREEN_W / 2, QR_CY, QR_BOX);

    // Bottom row — NFC hint on the LEFT
    drawNfcHint(tft, 0);

    // Bottom row — trashcan (cancel) button on the RIGHT
    tft.fillRoundRect(TRASH_X, ROW_Y, TRASH_W, ROW_H, 8, COL_CARD);
    tft.drawRoundRect(TRASH_X, ROW_Y, TRASH_W, ROW_H, 8, COL_BORDER);
    drawTrashIcon(tft, TRASH_X + TRASH_W / 2, ROW_CY, COL_MUTED);

    _lastPulse  = millis();
    _pulsePhase = 0;
}

void PaymentScreen::drawAmountHeader(TFT_eSPI& tft, long amountSats, const String& fiatLabel) {
    String sats = groupDigits(amountSats) + " sats";

    // Measure both parts (in their own fonts) so the pair can be centred.
    tft.setTextFont(FONT_SMALL);
    int w1 = tft.textWidth(fiatLabel);
    tft.setTextFont(FONT_SMALL);
    int w2 = tft.textWidth(sats);

    const int gap = 10;
    int total = w1 + gap + w2;
    int sx = (SCREEN_W - total) / 2;
    if (sx < 4) sx = 4;

    tft.setTextDatum(ML_DATUM);

    // Fiat — primary, white, large
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_TEXT, COL_BG);
    tft.drawString(fiatLabel, sx, AMT_CY);

    // Sats — secondary, Bitcoin orange, small, on the same line
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_ACCENT, COL_BG);
    tft.drawString(sats, sx + w1 + gap, AMT_CY);
}

void PaymentScreen::drawTimer(TFT_eSPI& tft, int rem) {
    char b[12];
    snprintf(b, sizeof(b), "%d:%02d", rem / 60, rem % 60);

    // Clear just the corner band, then redraw (avoids flicker on the rest).
    tft.fillRect(SCREEN_W - 58, 0, 58, 18, COL_BG);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(rem <= 10 ? COL_ERROR : COL_MUTED, COL_BG);
    tft.setTextDatum(TR_DATUM);
    tft.drawString(b, SCREEN_W - 6, 3);
}

void PaymentScreen::drawQR(TFT_eSPI& tft, const String& bolt11, int cx, int cy, int boxPx) {
    // bolt11 uppercased keeps the QR in alphanumeric mode (smaller / denser).
    String upper = bolt11;
    upper.toUpperCase();

    // Static so the buffer lives in BSS (data segment) rather than on the ESP32
    // task stack, avoiding a stack-canary crash after deep call chains.
    // Size = qrcode_getBufferSize(20) = ((4*20+17)^2 + 7)/8 + 1 = 1178 bytes.
    // Safe: drawQR is only called from the single Arduino loop thread; never
    // recursively. qrcode is re-initialised on every call so stale state is fine.
    static constexpr uint16_t kQrBufSize = (((4 * 20 + 17) * (4 * 20 + 17)) + 7) / 8 + 1;
    static uint8_t buf[kQrBufSize];
    static QRCode qrcode;

    // Pick the highest QR version that (a) still gives >=2px per module in the
    // box and (b) can hold the invoice data.  Iterating HIGH→LOW means we stop
    // at the FIRST success — typically just ONE qrcode_initText call (v14 for any
    // real bolt11).  Iterating low→high and tracking bestTotal would call
    // qrcode_initText up to 9 times, which combined with the preceding HTTPS POST
    // trips the 5-second watchdog.  The result is identical in practice: the
    // highest version with mod>=2 maximises total rendered pixels (146px for v14).
    int bestVer = 0, bestMod = 0;
    for (int v = 20; v >= 6; v--) {
        int sz  = 4 * v + 17;
        int mod = boxPx / sz;
        if (mod < 2) continue;                       // won't render >=2px in the box
        if (qrcode_initText(&qrcode, buf, v, ECC_LOW, upper.c_str()) != 0) continue; // data too big
        bestVer = v; bestMod = mod; break;           // highest valid version → stop
    }
    // Safety net: invoice too long to fit at >=2px — use smallest version that holds it.
    if (bestVer == 0) {
        for (int v = 6; v <= 20; v++) {
            if (qrcode_initText(&qrcode, buf, v, ECC_LOW, upper.c_str()) == 0) {
                bestVer = v; bestMod = boxPx / (4 * v + 17); if (bestMod < 1) bestMod = 1;
                break;
            }
        }
        if (bestVer == 0) return;                    // unreachable for a valid bolt11
    }
    // qrcode is already initialised on bestVer from the loop above — no re-init needed.

    int totalPx = qrcode.size * bestMod;
    int startX  = cx - totalPx / 2;
    int startY  = cy - totalPx / 2;

    // White rounded card behind the QR — quiet zone padding + a premium look.
    const int pad = 6;
    tft.fillRoundRect(startX - pad, startY - pad, totalPx + 2 * pad, totalPx + 2 * pad, 7, TFT_WHITE);

    for (int row = 0; row < qrcode.size; row++) {
        for (int col = 0; col < qrcode.size; col++) {
            uint16_t color = qrcode_getModule(&qrcode, col, row) ? TFT_BLACK : TFT_WHITE;
            tft.fillRect(startX + col * bestMod, startY + row * bestMod, bestMod, bestMod, color);
        }
    }
}

void PaymentScreen::drawNfcHint(TFT_eSPI& tft, int phase) {
    // Subtle, borderless: a small dot + muted text, gently pulsing.
    // LEFT-aligned on the bottom row; clear only up to the trash button.
    tft.fillRect(0, NFC_CY - 9, NFC_CLEAR_W, 18, COL_BG);

    const char* label = "Tap a Bolt Card";
    const int iconR = 4, gap = 8;
    int sx = 8;   // left margin

    // Dot dims between muted and a soft orange — far less attention-grabbing
    // than the old bright pulsing rings.
    uint16_t dotc = (phase == 1) ? COL_ACCENT_DIM : COL_MUTED;
    tft.fillCircle(sx + iconR, NFC_CY, iconR, dotc);

    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_MUTED, COL_BG);
    tft.setTextDatum(ML_DATUM);
    tft.drawString(label, sx + iconR * 2 + gap, NFC_CY);
}

void PaymentScreen::update(TFT_eSPI& tft) {
    uint32_t now = millis();

    // Subtle NFC pulse — slow two-phase fade.
    if (now - _lastPulse >= 900) {
        _lastPulse  = now;
        _pulsePhase = (_pulsePhase + 1) % 2;
        drawNfcHint(tft, _pulsePhase);
    }

    // Countdown — only repaint when the displayed second changes.
    int rem = remainingSec(now);
    if (rem != _lastShownSec) {
        _lastShownSec = rem;
        drawTimer(tft, rem);
    }
}

void PaymentScreen::showCardDetected(TFT_eSPI& tft) {
    // Replace the subtle hint with a clear "hold still" prompt while the card
    // is being read. LEFT-aligned; the QR, amount line, and trash button stay.
    tft.fillRect(0, NFC_CY - 9, NFC_CLEAR_W, 18, COL_BG);

    const char* label = "Hold card still...";
    const int iconR = 4, gap = 8;
    int sx = 8;   // left margin

    tft.fillCircle(sx + iconR, NFC_CY, iconR, COL_ACCENT);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_ACCENT, COL_BG);
    tft.setTextDatum(ML_DATUM);
    tft.drawString(label, sx + iconR * 2 + gap, NFC_CY);
}

bool PaymentScreen::handleTouch(int tx, int ty) {
    // Trash (cancel) button on the right of the bottom row, with a small margin.
    return (tx >= TRASH_X - 6 && tx <= TRASH_X + TRASH_W + 6 &&
            ty >= ROW_Y - 4 && ty <= ROW_Y + ROW_H + 4);
}
