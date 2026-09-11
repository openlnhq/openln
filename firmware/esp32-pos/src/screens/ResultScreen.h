#pragma once
#include <TFT_eSPI.h>
#include <Arduino.h>

enum ResultType { RESULT_SUCCESS, RESULT_ERROR };

class ResultScreen {
public:
    // Draw success or error screen.
    // sent=true shows "Payment Sent" instead of "Payment received" (for send mode).
    // successTitle overrides the success title for context-specific messages.
    // errorTitle overrides the default "Payment failed" title for context-specific errors.
    static void draw(TFT_eSPI& tft, ResultType type,
                     long amountSats = 0, const String& errorMsg = "",
                     bool sent = false, const String& errorTitle = "Payment failed",
                     const String& successTitle = "");

    static bool handleTouch(int tx, int ty);
    static bool shouldAutoDismiss();

private:
    static ResultType _type;
    static uint32_t   _drawTime;

    static const int RETRY_Y = 182;
    static const int RETRY_H = 40;
};
