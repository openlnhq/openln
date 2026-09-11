#pragma once
#include <TFT_eSPI.h>
#include "Theme.h"

/**
 * posBOX icon system — vector-style icons drawn with TFT primitives.
 * All icons are drawn at a given (x, y) center point with a given size + color.
 * No bitmap data stored in flash — every icon is drawn with fillRect, drawLine,
 * fillCircle, drawCircleArc. This keeps flash cost at zero (code only).
 */

namespace Icons {

// ── WiFi icon — 3 arcs + dot, centered at (cx, cy) ──────────────────────────
inline void wifi(TFT_eSPI& tft, int cx, int cy, int r, uint16_t color) {
    // Bottom dot
    tft.fillCircle(cx, cy + r / 2, 2, color);
    // 3 arcs (drawn as circle segments using arcs)
    for (int i = 1; i <= 3; i++) {
        int radius = r * i / 3;
        // Top half arc — draw as series of points
        for (int a = 200; a <= 340; a += 4) {
            float rad = a * PI / 180.0;
            int x = cx + cos(rad) * radius;
            int y = cy + r / 2 + sin(rad) * radius;
            tft.drawPixel(x, y, color);
            tft.drawPixel(x + 1, y, color);
        }
    }
}

// ── Bolt card icon — rounded rectangle with contactless symbol ─────────────
inline void card(TFT_eSPI& tft, int cx, int cy, int w, int h, uint16_t color) {
    // Card body
    tft.drawRoundRect(cx - w / 2, cy - h / 2, w, h, 4, color);
    // Contactless arcs (right side)
    int ax = cx + w / 2 - 10;
    int ay = cy;
    for (int i = 1; i <= 3; i++) {
        int r = 3 + i * 3;
        for (int a = 180; a <= 360; a += 6) {
            float rad = a * PI / 180.0;
            int x = ax + cos(rad) * r;
            int y = ay + sin(rad) * r;
            tft.drawPixel(x, y, color);
        }
    }
}

// ── Bitcoin logo — circle + ฿ symbol drawn with lines ──────────────────────
inline void bitcoin(TFT_eSPI& tft, int cx, int cy, int r, uint16_t color) {
    tft.fillCircle(cx, cy, r, color);
    // ฿ symbol — vertical line + two bumps (simplified)
    int bw = r * 4 / 5;  // body width
    tft.fillRoundRect(cx - 2, cy - bw / 2, 4, bw, 2, COL_BG);
    // Top serif
    tft.fillRect(cx - 5, cy - bw / 2, 10, 3, COL_BG);
    // Bottom serif
    tft.fillRect(cx - 5, cy + bw / 2 - 3, 10, 3, COL_BG);
    // Upper bump
    tft.drawCircle(cx + 5, cy - bw / 4, 4, COL_BG);
    tft.fillCircle(cx + 5, cy - bw / 4, 2, COL_BG);
    // Lower bump
    tft.drawCircle(cx + 5, cy + bw / 4, 4, COL_BG);
    tft.fillCircle(cx + 5, cy + bw / 4, 2, COL_BG);
}

// ── Checkmark — drawn in a circle ──────────────────────────────────────────
inline void checkmark(TFT_eSPI& tft, int cx, int cy, int r, uint16_t ring, uint16_t tick) {
    // Ring
    tft.fillCircle(cx, cy, r, ring);
    tft.fillCircle(cx, cy, r - 4, COL_BG);
    // Tick — two thick lines
    for (int d = -2; d <= 2; d++) {
        tft.drawLine(cx - r / 2, cy + d, cx - r / 6, cy + r / 3 + d, tick);
        tft.drawLine(cx - r / 6, cy + r / 3 + d, cx + r / 2, cy - r / 3 + d, tick);
    }
}

// ── X mark — drawn in a circle ──────────────────────────────────────────────
inline void cross(TFT_eSPI& tft, int cx, int cy, int r, uint16_t ring, uint16_t x) {
    tft.fillCircle(cx, cy, r, ring);
    tft.fillCircle(cx, cy, r - 4, COL_BG);
    int s = r * 2 / 3;
    for (int d = -2; d <= 2; d++) {
        tft.drawLine(cx - s + d, cy - s, cx + s + d, cy + s, x);
        tft.drawLine(cx + s + d, cy - s, cx - s + d, cy + s, x);
    }
}

// ── Gear icon — settings ───────────────────────────────────────────────────
inline void gear(TFT_eSPI& tft, int cx, int cy, int r, uint16_t color) {
    tft.fillCircle(cx, cy, r, color);
    tft.fillCircle(cx, cy, r - 3, COL_BG);  // hollow
    // 8 teeth
    for (int a = 0; a < 360; a += 45) {
        float rad = a * PI / 180.0;
        int tx = cx + (int)(cos(rad) * (r + 1));
        int ty = cy + (int)(sin(rad) * (r + 1));
        tft.fillCircle(tx, ty, 2, color);
    }
}

// ── Back arrow — left-pointing chevron ─────────────────────────────────────
inline void back(TFT_eSPI& tft, int cx, int cy, int s, uint16_t color) {
    for (int d = 0; d < 3; d++) {
        tft.drawLine(cx - s / 2 + d, cy, cx, cy - s / 2 + d, color);
        tft.drawLine(cx - s / 2 + d, cy, cx, cy + s / 2 - d, color);
    }
}

// ── NFC / tap icon — card with radio waves ─────────────────────────────────
inline void nfc(TFT_eSPI& tft, int cx, int cy, int r, uint16_t color) {
    // Radio waves on the left
    for (int i = 1; i <= 3; i++) {
        int wr = r * i / 3;
        for (int a = 120; a <= 240; a += 4) {
            float rad = a * PI / 180.0;
            int x = cx - r / 3 + cos(rad) * wr;
            int y = cy + sin(rad) * wr;
            tft.drawPixel(x, y, color);
        }
    }
    // Card on the right
    tft.drawRoundRect(cx + 2, cy - r / 2, r, r, 3, color);
}

// ── Send arrow — upward arrow ──────────────────────────────────────────────
inline void send(TFT_eSPI& tft, int cx, int cy, int s, uint16_t color) {
    // Arrow head (triangle pointing up)
    tft.fillTriangle(cx, cy - s / 2, cx - s / 3, cy, cx + s / 3, cy, color);
    // Shaft
    tft.fillRect(cx - 2, cy, 4, s / 2, color);
}

// ── Receive arrow — downward arrow ────────────────────────────────────────
inline void receive(TFT_eSPI& tft, int cx, int cy, int s, uint16_t color) {
    // Shaft
    tft.fillRect(cx - 2, cy - s / 2, 4, s / 2, color);
    // Arrow head (triangle pointing down)
    tft.fillTriangle(cx, cy + s / 2, cx - s / 3, cy, cx + s / 3, cy, color);
}

// ── Signal bars — WiFi strength indicator ─────────────────────────────────
inline void signalBars(TFT_eSPI& tft, int x, int y, int strength, uint16_t color) {
    // strength: 0-4
    int barW = 3;
    int gap = 2;
    int heights[] = {3, 6, 9, 12};
    for (int i = 0; i < 4; i++) {
        int h = heights[i];
        uint16_t c = (i < strength) ? color : COL_CARD_HI;
        tft.fillRect(x + i * (barW + gap), y + 12 - h, barW, h, c);
    }
}

// ── Lock icon — padlock ───────────────────────────────────────────────────
inline void lock(TFT_eSPI& tft, int cx, int cy, int s, uint16_t color) {
    // Shackle (arc — drawn pixel by pixel since TFT_eSPI 2.x has no drawArc)
    int r = s / 3;
    for (int a = 180; a <= 360; a += 4) {
        float rad = a * PI / 180.0;
        int x = cx + cos(rad) * r;
        int y = cy - s / 4 + sin(rad) * r;
        tft.drawPixel(x, y, color);
        tft.drawPixel(x + 1, y, color);
    }
    // Body
    tft.fillRoundRect(cx - s / 3, cy - 2, s * 2 / 3, s / 2, 2, color);
}

} // namespace Icons
