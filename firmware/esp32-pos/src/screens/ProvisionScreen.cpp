#include "ProvisionScreen.h"
#include "../ui/Theme.h"

uint32_t ProvisionScreen::_lastPulse = 0;
int      ProvisionScreen::_pulsePhase = 0;

void ProvisionScreen::draw(TFT_eSPI& tft) {
    tft.fillScreen(COL_BG);

    // Title
    tft.setTextColor(TFT_WHITE, COL_BG);
    tft.setTextDatum(TC_DATUM);
    tft.setTextFont(FONT_SMALL);
    tft.drawString("RIC", SCREEN_W / 2, 30);

    // BLE circles (static initial render)
    int cx = SCREEN_W / 2;
    int cy = SCREEN_H / 2 - 20;
    tft.drawCircle(cx, cy, 40, COL_ACCENT);
    tft.drawCircle(cx, cy, 55, COL_ACCENT / 2);
    tft.drawCircle(cx, cy, 70, COL_ACCENT / 4);

    // BLE icon (simplified: three arcs represented as filled circles)
    tft.fillCircle(cx, cy, 8, COL_ACCENT);

    // Instructions
    tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_MUTED, COL_BG);
    tft.setTextDatum(TC_DATUM);
    tft.drawString("Open the openLN app to", SCREEN_W / 2, SCREEN_H / 2 + 65);
    tft.drawString("link this device", SCREEN_W / 2, SCREEN_H / 2 + 85);

    _lastPulse = millis();
    _pulsePhase = 0;
}

void ProvisionScreen::update(TFT_eSPI& tft) {
    if (millis() - _lastPulse < 600) return;
    _lastPulse = millis();
    _pulsePhase = (_pulsePhase + 1) % 3;

    int cx = SCREEN_W / 2;
    int cy = SCREEN_H / 2 - 20;

    // Animate rings — cycle brightness
    int r1 = 40, r2 = 55, r3 = 70;
    uint16_t c0 = COL_BG;
    uint16_t ca = COL_ACCENT;
    uint16_t ch = COL_ACCENT / 2;
    uint16_t cq = COL_ACCENT / 4;

    tft.drawCircle(cx, cy, r1, (_pulsePhase == 0) ? ca : (_pulsePhase == 1) ? ch : cq);
    tft.drawCircle(cx, cy, r2, (_pulsePhase == 1) ? ca : (_pulsePhase == 0) ? ch : cq);
    tft.drawCircle(cx, cy, r3, (_pulsePhase == 2) ? ca : (_pulsePhase == 1) ? ch : cq);
}
