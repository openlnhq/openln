#pragma once
#include <TFT_eSPI.h>

/**
 * Settings menu — opened from the gear icon in AmountScreen header.
 * Shows a list of options: WiFi, Issue Card, Wipe Card, Read Card.
 * The caller (main.cpp) handles the selected option.
 */

enum SettingsOption {
    SETTINGS_BACK = 0,
    SETTINGS_WIFI = 1,
    SETTINGS_ISSUE_CARD = 2,
    SETTINGS_WIPE_CARD = 3,
    SETTINGS_READ_CARD = 4,
    SETTINGS_UPDATES = 5,
};

class SettingsMenu {
public:
    static void draw(TFT_eSPI& tft);
    static int handleTouch(int tx, int ty);

private:
    static const int ITEM_COUNT = 6;  // back + 4 options
    static const int HEADER_H   = 20;
    static const int ITEM_H      = 36;
    static const int LIST_Y      = HEADER_H;  // items start right below header
};
