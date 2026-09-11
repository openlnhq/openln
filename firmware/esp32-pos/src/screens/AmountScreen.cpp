#include "AmountScreen.h"
#include "../ui/Theme.h"
#include "../ui/Icons.h"

long   AmountScreen::_whole       = 0;
long   AmountScreen::_frac        = 0;
int    AmountScreen::_fracLen     = 0;
bool   AmountScreen::_decimalMode = false;
int    AmountScreen::_decimals    = 2;
float  AmountScreen::_satsPerUnit = 0.0f;
float  AmountScreen::_sendSatsPerUnit = 0.0f;
String AmountScreen::_currencyCode = "usd";
Numpad AmountScreen::_numpad;

bool     AmountScreen::_online       = true;
bool     AmountScreen::_stale        = false;
uint16_t AmountScreen::_lastDotColor = 0xFFFF;
String   AmountScreen::_lastRateStr  = "";

bool     AmountScreen::_sendMode      = false;
bool     AmountScreen::_payHoldActive = false;
uint32_t AmountScreen::_payHoldStart  = 0;
int      AmountScreen::_payHoldTx     = 0;
int      AmountScreen::_payHoldTy     = 0;

int AmountScreen::currencyDecimals(const String& code) {
    String c = code; c.toUpperCase();
    static const char* ZERO[] = {
        "JPY","KRW","VND","CLP","ISK","PYG","XAF","XOF",
        "XPF","RWF","BIF","DJF","GNF","KMF","VUV","UGX",
    };
    for (unsigned i = 0; i < sizeof(ZERO)/sizeof(ZERO[0]); i++)
        if (c == ZERO[i]) return 0;
    return 2;
}

void AmountScreen::setPrice(float satsPerUnit, const String& currencyCode) {
    _satsPerUnit  = satsPerUnit;
    _currencyCode = currencyCode;
    _decimals     = currencyDecimals(currencyCode);
    if (satsPerUnit > 0.0f) { _online = true; _stale = false; }
}

void AmountScreen::setStatus(bool online, bool stale) { _online = online; _stale = stale; }
bool AmountScreen::hasInput() { return _whole != 0 || _frac != 0 || _decimalMode; }

double AmountScreen::currentValue() {
    double v = (double)_whole;
    if (_fracLen > 0) {
        double scale = 1.0;
        for (int i = 0; i < _fracLen; i++) scale *= 10.0;
        v += (double)_frac / scale;
    }
    return v;
}

long AmountScreen::getAmountSats() {
    float rate = (_sendMode && _sendSatsPerUnit > 0.0f) ? _sendSatsPerUnit : _satsPerUnit;
    if (rate <= 0.0f) return 0;
    double sats = currentValue() * (double)rate + 0.5;
    if (sats > 99000000.0) sats = 99000000.0;
    if (sats < 0.0) sats = 0.0;
    return (long)sats;
}

String AmountScreen::groupDigits(long v) {
    String s = String(v), out;
    int len = s.length();
    for (int i = 0; i < len; i++) {
        if (i > 0 && (len - i) % 3 == 0) out += ',';
        out += s[i];
    }
    return out;
}

String AmountScreen::amountString() {
    String s = groupDigits(_whole);
    if (_decimalMode) {
        s += '.';
        if (_fracLen > 0) { char fb[12]; snprintf(fb, sizeof(fb), "%0*ld", _fracLen, _frac); s += fb; }
    }
    return s;
}

String AmountScreen::fiatLabel() {
    String code = _currencyCode; code.toUpperCase();
    return amountString() + " " + code;
}

String AmountScreen::rateString() {
    float rate = (_sendMode && _sendSatsPerUnit > 0.0f) ? _sendSatsPerUnit : _satsPerUnit;
    if (rate <= 0.0f) return String("-");
    String code = _currencyCode; code.toUpperCase();
    char buf[24];
    snprintf(buf, sizeof(buf), rate >= 10.0f ? "%.0f sats/%s" : "%.1f sats/%s", rate, code.c_str());
    return String(buf);
}

uint16_t AmountScreen::dotColor() {
    if (_satsPerUnit <= 0.0f) return COL_MUTED;
    if (!_online)             return COL_ERROR;
    if (_stale)               return COL_ACCENT;
    return COL_SUCCESS;
}

void AmountScreen::draw(TFT_eSPI& tft) {
    _whole = 0; _frac = 0; _fracLen = 0; _decimalMode = false;
    tft.fillScreen(COL_BG);
    drawHeader(tft);
    _numpad.draw(tft, NUMPAD_Y, NUMPAD_AMOUNT, NUMPAD_KH, _sendMode);
    drawPayButton(tft, false);
}

void AmountScreen::drawHeader(TFT_eSPI& tft) {
    // Header background
    tft.fillRect(0, 0, SCREEN_W, HEADER_H, COL_BG2);

    // Bottom accent line — orange when normal, deep orange in send mode
    tft.drawFastHLine(0, HEADER_H, SCREEN_W, _sendMode ? COL_ACCENT_DK : COL_BORDER);
    // 1px bright orange accent on top of the border for brand pop
    tft.drawFastHLine(0, HEADER_H - 1, SCREEN_W, _sendMode ? COL_ACCENT : COL_BORDER);

    // Gear icon — always grey
    Icons::gear(tft, 10, 10, 5, COL_MUTED);

    // Wordmark
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_TEXT, COL_BG2);
    tft.setTextDatum(TL_DATUM);
    tft.drawString("openLN", 24, 3);

    // Send mode badge (if active)
    if (_sendMode) {
        tft.fillRoundRect(68, 2, 38, 16, 4, COL_ACCENT);
        tft.setTextColor(COL_ON_ACCENT, COL_ACCENT);
        tft.setTextFont(FONT_SMALL);
        tft.setTextDatum(MC_DATUM);
        tft.drawString("SEND", 87, 10);
    }

    // Currency badge — right
    String badge = _currencyCode; badge.toUpperCase();
    tft.setTextColor(COL_ACCENT, COL_BG2);
    tft.setTextDatum(TR_DATUM);
    tft.drawString(badge, SCREEN_W - 4, 3);

    _lastDotColor = 0xFFFF;
    _lastRateStr  = "";
    updateHeader(tft);
}

void AmountScreen::updateHeader(TFT_eSPI& tft) {
    // Rate — centered between the send badge/dot and the currency badge
    String rs = rateString();
    if (rs != _lastRateStr) {
        // Clear the center area only — leave currency badge intact
        int clearStart = _sendMode ? 112 : 76;  // start AFTER the dot
        int clearEnd = SCREEN_W - 40;
        tft.fillRect(clearStart, 2, clearEnd - clearStart, 16, COL_BG2);
        tft.setTextFont(FONT_SMALL);
        tft.setTextColor(COL_MUTED, COL_BG2);
        tft.setTextDatum(TC_DATUM);
        int centerX = (clearStart + clearEnd) / 2;
        tft.drawString(rs, centerX, 3);
        _lastRateStr = rs;
    }

    // Status dot — drawn AFTER clearing so it's never overwritten
    uint16_t dc = dotColor();
    if (dc != _lastDotColor) {
        int dotX = _sendMode ? 112 : 68;
        tft.fillCircle(dotX, 10, 3, dc);
        _lastDotColor = dc;
    }
}

void AmountScreen::drawAmountDisplay(TFT_eSPI& tft) { (void)tft; }

void AmountScreen::updateAmountDisplay(TFT_eSPI& tft) {
    updateHeader(tft);
    drawPayButton(tft, getAmountSats() > 0);
}

void AmountScreen::drawPayButton(TFT_eSPI& tft, bool enabled) {
    const int btnY = PAY_BTN_Y;
    const int btnH = PAY_BTN_H;

    uint16_t bg, fg, subfg, border;

    if (enabled) {
        if (_sendMode) {
            // Send mode — red button, white text
            bg = COL_ERROR;
            fg = COL_TEXT;
            subfg = COL_TEXT;  // pure white
            border = COL_ERROR;
        } else {
            // Pay mode (receive) — green button, white text
            bg = 0x0668;  // #00cc44 — pure green (money coming in)
            fg = COL_TEXT;  // white
            subfg = COL_TEXT;  // pure white
            border = 0x0668;
        }
    } else {
        bg = COL_BG2;
        fg = COL_MUTED;
        subfg = COL_MUTED_DK;
        border = COL_BORDER;
    }

    // Top accent line — bright orange when enabled, border when disabled
    tft.drawFastHLine(0, btnY, SCREEN_W, border);

    // Main body
    tft.fillRect(0, btnY + 1, SCREEN_W, btnH - 1, bg);

    const char* verb = _sendMode ? "Send" : "Receive";

    tft.setTextDatum(MC_DATUM);
    tft.setTextColor(fg, bg);

    if (!hasInput()) {
        tft.setTextFont(FONT_MED);
        tft.drawString(verb, SCREEN_W / 2, btnY + btnH / 2);
    } else {
        String code = _currencyCode; code.toUpperCase();
        char fiatBuf[48];
        snprintf(fiatBuf, sizeof(fiatBuf), "%s %s %s", verb, amountString().c_str(), code.c_str());

        tft.setTextFont(FONT_MED);
        tft.setTextColor(fg, bg);
        tft.drawString(fiatBuf, SCREEN_W / 2, btnY + 14);

        tft.setTextFont(FONT_SMALL);
        tft.setTextColor(subfg, bg);
        if (_satsPerUnit > 0.0f) {
            char satsBuf[32];
            snprintf(satsBuf, sizeof(satsBuf), "%s sats", groupDigits(getAmountSats()).c_str());
            tft.drawString(satsBuf, SCREEN_W / 2, btnY + 32);
        } else {
            tft.drawString("Price unavailable", SCREEN_W / 2, btnY + 32);
        }
    }
}

bool AmountScreen::handleTouch(TFT_eSPI& tft, int tx, int ty) {
    if (ty >= PAY_BTN_Y && getAmountSats() > 0) return true;

    char key = _numpad.handleTouch(tx, ty, NUMPAD_Y, NUMPAD_AMOUNT, NUMPAD_KH);
    if (!key) return false;

    _numpad.flashKey(tft, tx, ty, NUMPAD_Y, NUMPAD_AMOUNT, NUMPAD_KH, _sendMode);

    const long WHOLE_CAP = 99999999L;
    if (key == '\x08') {
        if (_decimalMode) {
            if (_fracLen > 0) { _frac /= 10; _fracLen--; }
            else              { _decimalMode = false; }
        } else { _whole /= 10; }
    } else if (key == '.') {
        if (_decimals > 0 && !_decimalMode) _decimalMode = true;
    } else if (key >= '0' && key <= '9') {
        int d = key - '0';
        if (!_decimalMode) {
            long next = _whole * 10L + d;
            if (next <= WHOLE_CAP) _whole = next;
        } else if (_fracLen < _decimals) {
            _frac = _frac * 10L + d;
            _fracLen++;
        }
    }
    updateAmountDisplay(tft);
    return false;
}

bool AmountScreen::isSettingsTap(int tx, int ty) {
    return (tx >= 0 && tx < 28 && ty >= 0 && ty < 24);
}

extern float effectiveSatsPerUnit();

bool AmountScreen::isSendMode() { return _sendMode; }
void AmountScreen::setSendMode(bool en) {
    _sendMode = en;
    if (en) _sendSatsPerUnit = effectiveSatsPerUnit();
    else    _sendSatsPerUnit = 0.0f;
}
void AmountScreen::setSendSatsPerUnit(float satsPerUnit) { _sendSatsPerUnit = satsPerUnit; }

bool AmountScreen::isPayButtonHeld(int tx, int ty) {
    return (ty >= PAY_BTN_Y && ty < SCREEN_H && tx >= 0 && tx < SCREEN_W);
}
void AmountScreen::startPayHold(int tx, int ty) { _payHoldActive = true; _payHoldStart = millis(); _payHoldTx = tx; _payHoldTy = ty; }
bool AmountScreen::checkPayHold(uint32_t now) { return _payHoldActive && (now - _payHoldStart >= 5000); }
void AmountScreen::cancelPayHold() { _payHoldActive = false; }
bool AmountScreen::isPayHoldActive() { return _payHoldActive; }
