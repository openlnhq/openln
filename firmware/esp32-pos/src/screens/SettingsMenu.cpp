#include "SettingsMenu.h"
#include "../ui/Theme.h"
#include "../ui/Icons.h"

static const char* MENU_LABELS[] = {
    "Back", "WiFi Network", "Issue Card", "Wipe Card", "Read Card", "Firmware & Updates"
};

void SettingsMenu::draw(TFT_eSPI& tft) {
    tft.fillScreen(COL_BG);

    // Header — elevated with orange accent bottom line
    tft.fillRect(0, 0, SCREEN_W, HEADER_H, COL_BG2);
    tft.drawFastHLine(0, HEADER_H - 1, SCREEN_W, COL_ACCENT);
    tft.drawFastHLine(0, HEADER_H, SCREEN_W, COL_BORDER);
    tft.setTextDatum(TC_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_TEXT, COL_BG2);
    tft.drawString("Settings", SCREEN_W / 2, 3);

    for (int i = 0; i < ITEM_COUNT; i++) {
        int y = LIST_Y + i * ITEM_H;
        uint16_t iconColor;

        // Card with rounded corners + border
        tft.fillRoundRect(8, y, SCREEN_W - 16, ITEM_H - 6, 8, COL_CARD);
        tft.drawRoundRect(8, y, SCREEN_W - 16, ITEM_H - 6, 8, COL_BORDER);

        int ix = 28;
        int iy = y + (ITEM_H - 6) / 2;

        switch (i) {
            case 0: iconColor = COL_MUTED;    Icons::back(tft, ix, iy, 12, iconColor); break;
            case 1: iconColor = COL_ACCENT;   Icons::wifi(tft, ix, iy, 14, iconColor); break;
            case 2: iconColor = COL_SUCCESS;  Icons::card(tft, ix, iy, 24, 16, iconColor); break;
            case 3:
                iconColor = COL_ERROR;
                Icons::card(tft, ix, iy, 24, 16, iconColor);
                tft.drawLine(ix - 8, iy - 6, ix + 8, iy + 6, COL_ERROR);
                tft.drawLine(ix + 8, iy - 6, ix - 8, iy + 6, COL_ERROR);
                break;
            case 4: iconColor = COL_TEXT;    Icons::nfc(tft, ix, iy, 12, iconColor); break;
            case 5: Icons::gear(tft,ix,iy,7,COL_ACCENT); break;
        }

        // Label
        tft.setTextDatum(ML_DATUM);
        tft.setTextFont(FONT_SMALL);
        tft.setTextColor(COL_TEXT, COL_CARD);
        tft.drawString(MENU_LABELS[i], 50, iy);
    }
}

int SettingsMenu::handleTouch(int tx, int ty) {
    for (int i = 0; i < ITEM_COUNT; i++) {
        int y = LIST_Y + i * ITEM_H;
        if (tx >= 8 && tx < SCREEN_W - 8 && ty >= y && ty < y + ITEM_H - 6)
            return i;
    }
    return -1;
}
