#include "WifiSetupScreen.h"
#include "../ui/Theme.h"
#include <WiFi.h>

// ── Static state ──────────────────────────────────────────────────────────
WifiSetupScreen::SubScreen WifiSetupScreen::_sub = WifiSetupScreen::SCANNING;
WifiSetupScreen::Network   WifiSetupScreen::_networks[MAX_NETWORKS];
int      WifiSetupScreen::_networkCount    = 0;
int      WifiSetupScreen::_selectedNetwork = -1;
int      WifiSetupScreen::_scrollOffset     = 0;
char     WifiSetupScreen::_password[65]     = {0};
int      WifiSetupScreen::_passwordLen     = 0;
bool     WifiSetupScreen::_shiftMode        = false;
bool     WifiSetupScreen::_symbolMode       = false;
uint32_t WifiSetupScreen::_scanAnimLast     = 0;
int      WifiSetupScreen::_scanAnimFrame    = 0;
uint32_t WifiSetupScreen::_connectStart      = 0;

// ── Keyboard layouts ──────────────────────────────────────────────────────
// Lowercase letters — space at position [2][9] (replacing the old wide-space slot)
static const char* KB_LOWER[3][10] = {
    {"q","w","e","r","t","y","u","i","o","p"},
    {"a","s","d","f","g","h","j","k","l","\b"},  // \b = backspace
    {"\x01","z","x","c","v","b","n","m","\x02","\x03"}, // \x01=shift, \x02=123, \x03=space
};
// Uppercase letters
static const char* KB_UPPER[3][10] = {
    {"Q","W","E","R","T","Y","U","I","O","P"},
    {"A","S","D","F","G","H","J","K","L","\b"},
    {"\x01","Z","X","C","V","B","N","M","\x02","\x03"},
};
// Symbols / numbers
static const char* KB_SYMBOL[3][10] = {
    {"1","2","3","4","5","6","7","8","9","0"},
    {"-","/","\\","%","_",":",".","@","+","\b"},
    {"\x01","!","?","#","=","(",")","&","\x02","\x03"},
};

void WifiSetupScreen::enter(TFT_eSPI& tft) {
    _sub = SCANNING;
    _scanAnimLast  = 0;
    _scanAnimFrame = 0;
    _passwordLen   = 0;
    _password[0]   = '\0';
    _shiftMode     = false;
    _symbolMode    = false;
    _selectedNetwork = -1;
    _scrollOffset  = 0;
    doScan(tft);
}

// ── Scanning ──────────────────────────────────────────────────────────────
void WifiSetupScreen::drawScanning(TFT_eSPI& tft) {
    tft.fillScreen(COL_BG);
    tft.setTextDatum(MC_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_TEXT, COL_BG);
    tft.drawString("Scanning...", SCREEN_W / 2, SCREEN_H / 2 - 20);

    // Bounce dots
    const int dotY = SCREEN_H / 2 + 30, dotR = 10, gap = 44, cx = SCREEN_W / 2;
    tft.fillRect(0, dotY - dotR - 6, SCREEN_W, (dotR + 6) * 2, COL_BG);
    for (int i = 0; i < 3; i++) {
        int x = cx + (i - 1) * gap;
        bool lit = (i == _scanAnimFrame);
        int yOff = lit ? -4 : 0;
        if (lit) tft.fillCircle(x, dotY + yOff, dotR, COL_ACCENT);
        else     tft.drawCircle(x, dotY + yOff, dotR, COL_MUTED);
    }
}

void WifiSetupScreen::doScan(TFT_eSPI& tft) {
    drawScanning(tft);

    // Scan — this blocks for 2-4 seconds
    int n = WiFi.scanNetworks(false, false);
    _networkCount = 0;
    if (n > 0) {
        for (int i = 0; i < n && _networkCount < MAX_NETWORKS; i++) {
            String ssid = WiFi.SSID(i);
            int rssi = WiFi.RSSI(i);
            bool enc = (WiFi.encryptionType(i) != WIFI_AUTH_OPEN);
            strncpy(_networks[_networkCount].ssid, ssid.c_str(), 32);
            _networks[_networkCount].ssid[32] = '\0';
            _networks[_networkCount].rssi = rssi;
            _networks[_networkCount].encrypted = enc;
            _networkCount++;
        }
    }
    WiFi.scanDelete();

    // Sort by RSSI descending (strongest first)
    for (int i = 0; i < _networkCount - 1; i++) {
        for (int j = i + 1; j < _networkCount; j++) {
            if (_networks[j].rssi > _networks[i].rssi) {
                Network tmp = _networks[i];
                _networks[i] = _networks[j];
                _networks[j] = tmp;
            }
        }
    }

    _sub = NETWORK_LIST;
    drawNetworkList(tft);
}

// ── Network list ─────────────────────────────────────────────────────────
String WifiSetupScreen::signalBars(int rssi) {
    if (rssi >= -55) return "====";
    if (rssi >= -65) return "===";
    if (rssi >= -75) return "==";
    if (rssi >= -85) return "=";
    return ".";
}

void WifiSetupScreen::drawNetworkList(TFT_eSPI& tft) {
    tft.fillScreen(COL_BG);

    // Header
    tft.setTextDatum(TL_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_TEXT, COL_BG);
    tft.drawString("Select WiFi Network", 8, 4);

    // Back button (top-right)
    tft.fillRoundRect(SCREEN_W - 60, 2, 52, 24, 6, COL_CARD);
    tft.drawRoundRect(SCREEN_W - 60, 2, 52, 24, 6, COL_BORDER);
    tft.setTextColor(COL_MUTED, COL_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString("Back", SCREEN_W - 34, 14);

    // Separator
    tft.drawFastHLine(0, 30, SCREEN_W, COL_BORDER);

    // Network rows
    int visibleCount = (_networkCount < MAX_VISIBLE) ? _networkCount : MAX_VISIBLE;
    for (int i = 0; i < visibleCount; i++) {
        int idx = i + _scrollOffset;
        if (idx >= _networkCount) break;

        int y = LIST_Y + i * LIST_ITEM_H;
        bool selected = (idx == _selectedNetwork);

        // Row background
        uint16_t bg = selected ? COL_CARD_HI : COL_CARD;
        tft.fillRoundRect(4, y + 2, SCREEN_W - 8, LIST_ITEM_H - 4, 6, bg);
        tft.drawRoundRect(4, y + 2, SCREEN_W - 8, LIST_ITEM_H - 4, 6, COL_BORDER);

        // SSID
        tft.setTextDatum(ML_DATUM);
        tft.setTextFont(FONT_SMALL);
        tft.setTextColor(COL_TEXT, bg);
        // Truncate SSID if too long
        char display[28];
        strncpy(display, _networks[idx].ssid, 27);
        display[27] = '\0';
        tft.drawString(display, 14, y + LIST_ITEM_H / 2);

        // Signal bars + lock icon (right side)
        tft.setTextDatum(TR_DATUM);
        tft.setTextColor(COL_MUTED, bg);
        String info = "";
        if (_networks[idx].encrypted) info += "*";
        info += signalBars(_networks[idx].rssi);
        tft.drawString(info, SCREEN_W - 14, y + LIST_ITEM_H / 2);
    }

    // Scroll indicator
    if (_networkCount > MAX_VISIBLE) {
        tft.setTextDatum(TL_DATUM);
        tft.setTextColor(COL_MUTED, COL_BG);
        tft.setTextFont(FONT_SMALL);
        char buf[16];
        snprintf(buf, sizeof(buf), "%d/%d", _scrollOffset + 1, _networkCount);
        tft.drawString(buf, 8, SCREEN_H - 14);
    }

    if (_networkCount == 0) {
        tft.setTextDatum(MC_DATUM);
        tft.setTextFont(FONT_SMALL);
        tft.setTextColor(COL_MUTED, COL_BG);
        tft.drawString("No networks found", SCREEN_W / 2, SCREEN_H / 2);
        tft.drawString("Tap Back to retry", SCREEN_W / 2, SCREEN_H / 2 + 20);
    }
}

// ── Password entry ───────────────────────────────────────────────────────
void WifiSetupScreen::drawPasswordField(TFT_eSPI& tft) {
    // Field background — tall enough for 2 lines of text
    tft.fillRoundRect(8, PASS_FIELD_Y - 16, SCREEN_W - 16, 30, 6, COL_CARD);
    tft.drawRoundRect(8, PASS_FIELD_Y - 16, SCREEN_W - 16, 30, 6, COL_BORDER);

    // SSID label (small, above field)
    tft.setTextDatum(TL_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_MUTED, COL_BG);
    tft.drawString("Password for:", 10, PASS_FIELD_Y - 30);
    tft.setTextColor(COL_ACCENT, COL_BG);
    tft.drawString(_networks[_selectedNetwork].ssid, 90, PASS_FIELD_Y - 30);

    // Password text — show actual characters (merchant device, not public).
    // Truncate display if too long; scroll left when it exceeds the field width.
    tft.setTextDatum(ML_DATUM);
    tft.setTextColor(COL_TEXT, COL_CARD);
    tft.setTextFont(FONT_SMALL);
    String display = String(_password);
    // Show as much as fits, scrolling from the right
    int maxChars = 24;  // approximate fit at FONT_SMALL in 290px width
    String visible = display;
    if (visible.length() > maxChars) {
        visible = "..." + visible.substring(visible.length() - maxChars + 3);
    }
    tft.drawString(visible, 16, PASS_FIELD_Y);
}

const char* WifiSetupScreen::getKeyLabel(int row, int col) {
    const char* (*layout)[10] = _symbolMode ? KB_SYMBOL : (_shiftMode ? KB_UPPER : KB_LOWER);
    return layout[row][col];
}

void WifiSetupScreen::drawKeyboard(TFT_eSPI& tft) {
    for (int r = 0; r < 3; r++) {
        for (int c = 0; c < KB_COLS; c++) {
            const char* label = getKeyLabel(r, c);
            int x = c * KB_KEY_W + 1;
            int y = KB_Y_OFFSET + r * KB_KEY_H + 2;
            int w = KB_KEY_W - 2;
            int h = KB_KEY_H - 4;

            // Special keys
            bool isBack = (label[0] == '\b');
            bool isShift = (label[0] == '\x01');
            bool isMode = (label[0] == '\x02');  // 123/ABC toggle
            bool isSpace = (label[0] == '\x03');

            uint16_t bg, fg;
            if (isShift && _shiftMode) {
                bg = COL_ACCENT; fg = COL_BG;
            } else if (isMode && _symbolMode) {
                bg = COL_ACCENT; fg = COL_BG;
            } else if (isBack || isShift || isMode || isSpace) {
                bg = COL_CARD_HI; fg = COL_MUTED;
            } else {
                bg = COL_CARD; fg = COL_TEXT;
            }

            tft.fillRoundRect(x, y, w, h, 4, bg);
            tft.drawRoundRect(x, y, w, h, 4, COL_BORDER);
            tft.setTextColor(fg, bg);
            tft.setTextDatum(MC_DATUM);
            tft.setTextFont(FONT_SMALL);

            if (isBack)         tft.drawString("<", x + w / 2, y + h / 2);
            else if (isShift)   tft.drawString(_shiftMode ? "A" : "a", x + w / 2, y + h / 2);
            else if (isMode)    tft.drawString(_symbolMode ? "ABC" : "123", x + w / 2, y + h / 2);
            else if (isSpace)   tft.drawString("_", x + w / 2, y + h / 2);
            else                tft.drawString(label, x + w / 2, y + h / 2);
        }
    }
}

void WifiSetupScreen::drawPasswordEntry(TFT_eSPI& tft) {
    tft.fillScreen(COL_BG);

    // Header
    tft.setTextDatum(TL_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_TEXT, COL_BG);
    tft.drawString("Enter WiFi Password", 8, 4);

    // Back button (top-right)
    tft.fillRoundRect(SCREEN_W - 60, 2, 52, 24, 6, COL_CARD);
    tft.drawRoundRect(SCREEN_W - 60, 2, 52, 24, 6, COL_BORDER);
    tft.setTextColor(COL_MUTED, COL_CARD);
    tft.setTextDatum(MC_DATUM);
    tft.drawString("Back", SCREEN_W - 34, 14);

    // Separator
    tft.drawFastHLine(0, 30, SCREEN_W, COL_BORDER);

    // Password field
    drawPasswordField(tft);

    // Keyboard
    drawKeyboard(tft);

    // Connect button (below keyboard)
    int connY = KB_Y_OFFSET + 3 * KB_KEY_H + 6;
    bool canConnect = (_passwordLen > 0);
    uint16_t bg = canConnect ? COL_SUCCESS : COL_CARD;
    uint16_t fg = canConnect ? TFT_WHITE   : COL_MUTED;
    tft.fillRoundRect(8, connY, SCREEN_W - 16, 30, 6, bg);
    tft.drawRoundRect(8, connY, SCREEN_W - 16, 30, 6, COL_BORDER);
    tft.setTextColor(fg, bg);
    tft.setTextDatum(MC_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.drawString("Connect", SCREEN_W / 2, connY + 15);
}

// ── Connecting animation ─────────────────────────────────────────────────
void WifiSetupScreen::drawConnecting(TFT_eSPI& tft) {
    tft.fillScreen(COL_BG);
    tft.setTextDatum(MC_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_TEXT, COL_BG);
    tft.drawString("Connecting...", SCREEN_W / 2, SCREEN_H / 2 - 22);

    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_MUTED, COL_BG);
    tft.drawString(_networks[_selectedNetwork].ssid, SCREEN_W / 2, SCREEN_H / 2 + 4);

    // Bounce dots
    if (millis() - _scanAnimLast > 500) {
        _scanAnimLast = millis();
        _scanAnimFrame = (_scanAnimFrame + 1) % 3;
        const int dotY = SCREEN_H / 2 + 40, dotR = 8, gap = 36, cx = SCREEN_W / 2;
        tft.fillRect(0, dotY - dotR - 4, SCREEN_W, (dotR + 4) * 2, COL_BG);
        for (int i = 0; i < 3; i++) {
            int x = cx + (i - 1) * gap;
            bool lit = (i == _scanAnimFrame);
            int yOff = lit ? -3 : 0;
            if (lit) tft.fillCircle(x, dotY + yOff, dotR, COL_ACCENT);
            else     tft.drawCircle(x, dotY + yOff, dotR, COL_MUTED);
        }
    }
}

// ── Keyboard touch handling ──────────────────────────────────────────────
char WifiSetupScreen::handleKeyboardTouch(int tx, int ty) {
    if (ty < KB_Y_OFFSET) return 0;

    // Check which row (only first 3 rows of letters)
    int row = (ty - KB_Y_OFFSET) / KB_KEY_H;
    if (row < 0 || row >= 3) return 0;

    int col = tx / KB_KEY_W;
    if (col < 0 || col >= KB_COLS) return 0;

    const char* label = getKeyLabel(row, col);
    if (!label) return 0;

    uint8_t k = label[0];

    if (k == '\b') {
        // Backspace
        if (_passwordLen > 0) {
            _passwordLen--;
            _password[_passwordLen] = '\0';
        }
        return '\b';
    }
    if (k == '\x01') {
        // Shift toggle
        _shiftMode = !_shiftMode;
        return 'S';  // signal redraw
    }
    if (k == '\x02') {
        // 123/ABC toggle
        _symbolMode = !_symbolMode;
        _shiftMode = false;
        return 'S';
    }
    if (k == '\x03') {
        // Space
        if (_passwordLen < 63) {
            _password[_passwordLen++] = ' ';
            _password[_passwordLen] = '\0';
        }
        return ' ';
    }

    // Regular character
    if (_passwordLen < 63) {
        _password[_passwordLen++] = k;
        _password[_passwordLen] = '\0';
        // Auto-unshift after typing a letter (like phone keyboards)
        if (_shiftMode && !_symbolMode) _shiftMode = false;
    }
    return k;
}

// ── Main touch handler ──────────────────────────────────────────────────
String WifiSetupScreen::handleTouch(TFT_eSPI& tft, int tx, int ty) {
    switch (_sub) {
        case SCANNING:
            // Can't interact during scan
            return "";

        case NETWORK_LIST: {
            // Back button
            if (tx >= SCREEN_W - 60 && tx < SCREEN_W - 8 && ty >= 2 && ty < 26) {
                return "cancelled";
            }

            // Network row tap
            int visibleCount = (_networkCount < MAX_VISIBLE) ? _networkCount : MAX_VISIBLE;
            for (int i = 0; i < visibleCount; i++) {
                int idx = i + _scrollOffset;
                if (idx >= _networkCount) break;
                int y = LIST_Y + i * LIST_ITEM_H;
                if (ty >= y + 2 && ty < y + LIST_ITEM_H - 2) {
                    _selectedNetwork = idx;
                    _passwordLen = 0;
                    _password[0] = '\0';
                    _shiftMode = false;
                    _symbolMode = false;

                    // If open network, connect immediately
                    if (!_networks[idx].encrypted) {
                        _sub = CONNECTING;
                        _connectStart = millis();
                        WiFi.disconnect(true);
                        WiFi.begin(_networks[idx].ssid);
                        drawConnecting(tft);
                        return "";
                    }

                    _sub = PASSWORD_ENTRY;
                    drawPasswordEntry(tft);
                    return "";
                }
            }
            return "";
        }

        case PASSWORD_ENTRY: {
            // Back button
            if (tx >= SCREEN_W - 60 && tx < SCREEN_W - 8 && ty >= 2 && ty < 26) {
                _sub = NETWORK_LIST;
                drawNetworkList(tft);
                return "";
            }

            // Connect button — check BEFORE keyboard (it's below the keyboard
            // and would be swallowed by the keyboard area check otherwise)
            int connY = KB_Y_OFFSET + 3 * KB_KEY_H + 6;
            if (ty >= connY && ty < connY + 30 && tx >= 8 && tx < SCREEN_W - 8) {
                if (_passwordLen > 0) {
                    _sub = CONNECTING;
                    _connectStart = millis();
                    WiFi.disconnect(true);
                    WiFi.begin(_networks[_selectedNetwork].ssid, _password);
                    drawConnecting(tft);
                }
                return "";
            }

            // Keyboard area
            if (ty >= KB_Y_OFFSET) {
                char k = handleKeyboardTouch(tx, ty);
                if (k == 'S') {
                    // Redraw keyboard (shift/symbol mode changed)
                    drawKeyboard(tft);
                    drawPasswordField(tft);
                } else if (k != 0) {
                    drawPasswordField(tft);
                }
                return "";
            }
            return "";
        }

        case CONNECTING: {
            // No interaction during connect — caller checks WiFi.status() in update()
            return "";
        }
    }
    return "";
}

// ── Getters for caller ───────────────────────────────────────────────────
String WifiSetupScreen::getSelectedSsid() {
    if (_selectedNetwork < 0 || _selectedNetwork >= _networkCount) return "";
    return String(_networks[_selectedNetwork].ssid);
}

String WifiSetupScreen::getSelectedPassword() {
    return String(_password);
}

// ── Periodic update ──────────────────────────────────────────────────────
// Returns:
//   ""           — still working (scanning or connecting)
//   "connected"  — WiFi connected (caller should save creds + resume)
//   "failed"     — connect timeout (back to list, user can retry)
//   "cancelled"  — user pressed back
String WifiSetupScreen::update(TFT_eSPI& tft) {
    if (_sub == SCANNING) {
        // Animate dots during scan (scan is blocking, so this only shows
        // briefly before doScan completes)
        if (millis() - _scanAnimLast > 500) {
            _scanAnimLast = millis();
            _scanAnimFrame = (_scanAnimFrame + 1) % 3;
            drawScanning(tft);
        }
        return "";
    }

    if (_sub == CONNECTING) {
        drawConnecting(tft);

        if (WiFi.status() == WL_CONNECTED) {
            return "connected";
        }
        if (millis() - _connectStart > 30000) {
            DBG_PRINTLN("WiFi connect timeout in setup");
            _sub = NETWORK_LIST;
            drawNetworkList(tft);
            return "failed";
        }
        return "";
    }

    return "";
}
