#pragma once
#include <TFT_eSPI.h>

class ProvisionScreen {
public:
    static void draw(TFT_eSPI& tft);
    // Kept for API compatibility: the Motion render task animates the beacon.
    static void update(TFT_eSPI& tft);
};
