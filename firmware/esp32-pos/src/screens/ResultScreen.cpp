#include "ResultScreen.h"
#include "../ui/Theme.h"
#include "../ui/Icons.h"

ResultType ResultScreen::_type     = RESULT_SUCCESS;
uint32_t   ResultScreen::_drawTime = 0;

void ResultScreen::draw(TFT_eSPI& tft, ResultType type,
                        long amountSats, const String& errorMsg, bool sent,
                        const String& errorTitle, const String& successTitle) {
    _type     = type;
    _drawTime = millis();

    if (type == RESULT_SUCCESS) {
        // ── BRIGHT SUCCESS — pure green background, large icons, bold text ──
        tft.fillScreen(COL_SUCCESS);

        int cx = SCREEN_W / 2, cy = 80;

        // Large white circle with dark checkmark — bold, eye-catching
        tft.fillCircle(cx, cy, 36, COL_TEXT);         // white circle
        tft.fillCircle(cx, cy, 32, COL_SUCCESS);       // green inner ring

        // Checkmark — dark green, thick, drawn with multiple offsets for boldness
        for (int d = -3; d <= 3; d++) {
            tft.drawLine(cx - 16, cy + d, cx - 4, cy + 12 + d, COL_SUCCESS_DK);
            tft.drawLine(cx - 4, cy + 12 + d, cx + 16, cy - 10 + d, COL_SUCCESS_DK);
        }

        // Title — white, large, bold
        tft.setTextColor(COL_TEXT, COL_SUCCESS);
        tft.setTextDatum(TC_DATUM);
        tft.setTextFont(FONT_MED);
        String title = successTitle.isEmpty()
            ? (sent ? "Payment Sent" : "Payment received")
            : successTitle;
        tft.drawString(title, cx, 140);

        // Amount — bright, large
        if (amountSats > 0) {
            char buf[32];
            snprintf(buf, sizeof(buf), "%ld sats", amountSats);
            tft.setTextFont(FONT_MED);
            tft.setTextColor(COL_TEXT, COL_SUCCESS);
            tft.drawString(buf, cx, 170);
        }

        // Bottom bar — dark green accent
        tft.fillRect(0, SCREEN_H - 6, SCREEN_W, 6, COL_SUCCESS_DK);

    } else {
        // ── ERROR — dark red bg, clear and readable ──
        tft.fillScreen(COL_ERROR_DK);

        int cx = SCREEN_W / 2, cy = 70;

        // Red circle with white X
        tft.fillCircle(cx, cy, 34, COL_ERROR);
        tft.fillCircle(cx, cy, 30, COL_ERROR_DK);

        // X mark — white, bold
        for (int d = -2; d <= 2; d++) {
            tft.drawLine(cx - 12, cy - 12 + d, cx + 12, cy + 12 + d, COL_ERROR);
            tft.drawLine(cx + 12, cy - 12 + d, cx - 12, cy + 12 + d, COL_ERROR);
        }

        // Title
        tft.setTextColor(COL_ERROR, COL_ERROR_DK);
        tft.setTextDatum(TC_DATUM);
        tft.setTextFont(FONT_MED);
        tft.drawString(errorTitle, cx, 130);

        // Error message
        if (!errorMsg.isEmpty()) {
            String msg = errorMsg;
            if (msg.length() > 38) msg = msg.substring(0, 38) + "...";
            tft.setTextFont(FONT_SMALL);
            tft.setTextColor(COL_TEXT_DIM, COL_ERROR_DK);
            tft.drawString(msg, cx, 158);
        }

        // Retry button — full-width red bar at bottom
        int btnY = RETRY_Y;
        int btnH = SCREEN_H - btnY;
        tft.fillRect(0, btnY, SCREEN_W, btnH, COL_ERROR);
        tft.setTextColor(COL_TEXT, COL_ERROR);
        tft.setTextFont(FONT_MED);
        tft.setTextDatum(MC_DATUM);
        tft.drawString("Retry", SCREEN_W / 2, btnY + btnH / 2);
    }
}

bool ResultScreen::handleTouch(int tx, int ty) {
    if (_type != RESULT_ERROR) return false;
    return (ty >= RETRY_Y);
}

bool ResultScreen::shouldAutoDismiss() {
    return (_type == RESULT_SUCCESS && millis() - _drawTime >= 3000);
}
