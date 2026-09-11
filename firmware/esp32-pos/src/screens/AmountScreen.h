#pragma once
#include <TFT_eSPI.h>
#include "../ui/Numpad.h"

class AmountScreen {
public:
    static void draw(TFT_eSPI& tft);
    static bool handleTouch(TFT_eSPI& tft, int tx, int ty);
    static long getAmountSats();
    static bool hasInput();
    static void setPrice(float satsPerUnit, const String& currencyCode);
    static void setStatus(bool online, bool stale);
    static void updateAmountDisplay(TFT_eSPI& tft);
    static void updateHeader(TFT_eSPI& tft);
    static String fiatLabel();
    static bool isSettingsTap(int tx, int ty);

    static bool isSendMode();
    static void setSendMode(bool enabled);
    static void setSendSatsPerUnit(float satsPerUnit);

    static bool isPayButtonHeld(int tx, int ty);
    static void startPayHold(int tx, int ty);
    static bool checkPayHold(uint32_t now);
    static void cancelPayHold();
    static bool isPayHoldActive();

private:
    static long _whole;
    static long _frac;
    static int  _fracLen;
    static bool _decimalMode;
    static int  _decimals;

    static float  _satsPerUnit;
    static float  _sendSatsPerUnit;
    static String _currencyCode;
    static Numpad _numpad;

    static bool     _online;
    static bool     _stale;
    static uint16_t _lastDotColor;
    static String   _lastRateStr;

    // Send mode state
    static bool     _sendMode;
    static bool     _payHoldActive;
    static uint32_t _payHoldStart;
    static int      _payHoldTx;
    static int      _payHoldTy;
    static const uint32_t PAY_HOLD_MS = 5000;

    // Layout: landscape 320×240
    //   Header:     y=0-20   (single line — gear + wordmark + rate + currency badge)
    //   Numpad:     y=20-200 (4 rows × 45px = 180px — fat finger friendly)
    //   Pay btn:    y=200-240 (40px — shows amount as you type)
    static const int HEADER_H   = 20;
    static const int NUMPAD_Y   = 20;
    static const int NUMPAD_KH  = 45;
    static const int PAY_BTN_Y  = 200;
    static const int PAY_BTN_H  = 40;

    static void   drawHeader(TFT_eSPI& tft);
    static void   drawAmountDisplay(TFT_eSPI& tft);
    static void   drawPayButton(TFT_eSPI& tft, bool enabled);
    static String groupDigits(long v);
    static String amountString();
    static double currentValue();
    static uint16_t dotColor();
    static String rateString();
    static int    currencyDecimals(const String& code);
};
