#include "Numpad.h"

static const char* KEYS_AMOUNT[4][3] = {
    { "1", "2", "3"    },
    { "4", "5", "6"    },
    { "7", "8", "9"    },
    { ".", "0", "\x08" },
};

static const char* KEYS_PIN[4][3] = {
    { "1", "2", "3"    },
    { "4", "5", "6"    },
    { "7", "8", "9"    },
    { " ", "0", "\x08" },
};

static const int KEY_W   = SCREEN_W / 3;
static const int KEY_GAP = 4;

void Numpad::draw(TFT_eSPI& tft, int originY, NumpadMode mode, int keyH,
                  bool sendMode) {
    const char* (*keys)[3] = (mode == NUMPAD_PIN) ? KEYS_PIN : KEYS_AMOUNT;
    for (int r = 0; r < 4; r++)
        for (int c = 0; c < 3; c++)
            drawKey(tft, c, r, originY, keys[r][c], keyH, false, sendMode);
}

void Numpad::drawKey(TFT_eSPI& tft, int col, int row, int originY,
                     const char* label, int keyH, bool highlight, bool sendMode) {
    int x = col * KEY_W + KEY_GAP;
    int y = originY + row * keyH + KEY_GAP;
    int w = KEY_W - KEY_GAP * 2;
    int h = keyH  - KEY_GAP * 2;

    if (label[0] == ' ') return;

    bool isBack = (label[0] == '\x08');

    // Color scheme:
    // Normal: dark card with subtle border
    // Send mode: deep orange tint
    // Highlight (pressed): bright orange with dark text
    // Backspace: darker, muted
    uint16_t bg, fg, border;

    if (highlight) {
        bg = COL_ACCENT;
        fg = COL_ON_ACCENT;
        border = COL_ACCENT_BR;
    } else if (sendMode && !isBack) {
        bg = COL_ERROR_DK;
        fg = COL_TEXT;
        border = COL_ERROR;
    } else if (isBack) {
        bg = COL_CARD;
        fg = COL_MUTED;
        border = COL_BORDER;
    } else {
        bg = COL_CARD;
        fg = COL_TEXT;
        border = COL_BORDER;
    }

    // Key with rounded corners + border for depth
    tft.fillRoundRect(x, y, w, h, 8, bg);
    tft.drawRoundRect(x, y, w, h, 8, border);

    // Subtle top highlight (1px lighter line inside top edge) for 3D feel
    if (!highlight) {
        tft.drawFastHLine(x + 4, y + 1, w - 8, COL_BORDER_HI);
    }

    tft.setTextColor(fg, bg);
    tft.setTextDatum(MC_DATUM);
    tft.setTextFont(FONT_MED);
    tft.drawString(isBack ? "<" : label, x + w / 2, y + h / 2);
}

char Numpad::handleTouch(int tx, int ty, int originY, NumpadMode mode, int keyH) {
    const char* (*keys)[3] = (mode == NUMPAD_PIN) ? KEYS_PIN : KEYS_AMOUNT;
    for (int r = 0; r < 4; r++) {
        for (int c = 0; c < 3; c++) {
            int x = c * KEY_W;
            int y = originY + r * keyH;
            if (tx >= x && tx < x + KEY_W && ty >= y && ty < y + keyH) {
                const char* label = keys[r][c];
                if (label[0] == ' ') return 0;
                if (label[0] == '\x08') return '\x08';
                return label[0];
            }
        }
    }
    return 0;
}

void Numpad::flashKey(TFT_eSPI& tft, int tx, int ty, int originY,
                      NumpadMode mode, int keyH, bool sendMode) {
    const char* (*keys)[3] = (mode == NUMPAD_PIN) ? KEYS_PIN : KEYS_AMOUNT;
    for (int r = 0; r < 4; r++) {
        for (int c = 0; c < 3; c++) {
            int x = c * KEY_W;
            int y = originY + r * keyH;
            if (tx >= x && tx < x + KEY_W && ty >= y && ty < y + keyH) {
                const char* label = keys[r][c];
                if (label[0] == ' ') return;
                drawKey(tft, c, r, originY, label, keyH, true, sendMode);
                delay(70);
                drawKey(tft, c, r, originY, label, keyH, false, sendMode);
                return;
            }
        }
    }
}
