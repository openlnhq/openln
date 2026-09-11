#pragma once
#include <TFT_eSPI.h>

class ProvisionScreen {
public:
    static void draw(TFT_eSPI& tft);
    // Call repeatedly from loop — animates the pulsing BLE ring
    static void update(TFT_eSPI& tft);

private:
    static uint32_t _lastPulse;
    static int      _pulsePhase;
};
