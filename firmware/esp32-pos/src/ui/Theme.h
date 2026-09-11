#pragma once
#include <TFT_eSPI.h>

// ── Debug output ────────────────────────────────────────────────────────────
#ifdef DEBUG
  #define DBG_PRINT(x)   Serial.print(x)
  #define DBG_PRINTF(...) Serial.printf(__VA_ARGS__)
  #define DBG_PRINTLN(x) Serial.println(x)
#else
  #define DBG_PRINT(x)
  #define DBG_PRINTF(...)
  #define DBG_PRINTLN(x)
#endif

// ── Display ────────────────────────────────────────────────────────────────
#define SCREEN_ROTATION 1
#define SCREEN_W        320
#define SCREEN_H        240

// ── Color palette (RGB565) — bitpos.app brand ──────────────────────────────
// Orange: #ea7c1e, bright: #f7a93c
// BG: #0a0a0a, surface: #1a1a1a, border: #333333
// Green: #22c55e, Red: #ef4444

#define COL_BG          0x0841   // #0a0a0a
#define COL_BG2         0x18C3   // #181818 — elevated
#define COL_CARD        0x2104   // #1a1a1a
#define COL_CARD_HI     0x2965   // #252525 — pressed
#define COL_BORDER      0x4208   // #333333
#define COL_BORDER_HI   0x528A   // #444444

#define COL_ACCENT      0xEBE3   // #ea7c1e — brand orange
#define COL_ACCENT_BR   0xFBE3   // #f7a93c — bright orange
#define COL_ACCENT_DK   0xA4C3   // #a05810 — deep orange
#define COL_ACCENT_DIM  0x6A20   // #664400 — dim orange

#define COL_ON_ACCENT   0x1860   // #1a0e06 — dark text on orange
#define COL_ON_ACCENT_DIM 0x4208  // dim dark on orange

#define COL_SUCCESS     0x262B   // #22c55e
#define COL_SUCCESS_DK  0x0162   // #052e16

#define COL_ERROR       0xE860   // #ef4444
#define COL_ERROR_DK    0x4000   // #400010

#define COL_TEXT        0xFFFF   // #ffffff
#define COL_TEXT_DIM    0xD308   // #aaaaaa
#define COL_MUTED       0x8C73   // #888888
#define COL_MUTED_DK    0x630C   // #666666

// ── Touch calibration ──────────────────────────────────────────────────────
#define TOUCH_X_MIN  200
#define TOUCH_X_MAX  3800
#define TOUCH_Y_MIN  200
#define TOUCH_Y_MAX  3800

// ── Fonts ──────────────────────────────────────────────────────────────────
#define FONT_TINY       1
#define FONT_SMALL      2   // 14px
#define FONT_MED        4   // 26px
#define FONT_LARGE      6   // 48px
#define FONT_BODY       2
