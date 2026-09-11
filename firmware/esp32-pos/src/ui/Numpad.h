#pragma once
#include <TFT_eSPI.h>
#include "../ui/Theme.h"

enum NumpadMode { NUMPAD_AMOUNT, NUMPAD_PIN };

class Numpad {
public:
    void draw(TFT_eSPI& tft, int originY,
              NumpadMode mode = NUMPAD_AMOUNT, int keyH = 50,
              bool sendMode = false);

    char handleTouch(int tx, int ty, int originY,
                     NumpadMode mode = NUMPAD_AMOUNT, int keyH = 50);

    void flashKey(TFT_eSPI& tft, int tx, int ty, int originY,
                  NumpadMode mode = NUMPAD_AMOUNT, int keyH = 50,
                  bool sendMode = false);

private:
    static const int COLS = 3;

    void drawKey(TFT_eSPI& tft, int col, int row, int originY,
                 const char* label, int keyH, bool highlight = false,
                 bool sendMode = false);
};
