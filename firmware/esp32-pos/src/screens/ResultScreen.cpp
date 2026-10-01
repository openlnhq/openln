#include "ResultScreen.h"
#include "../motion/Motion.h"
#include "../motion/MotionUi.h"
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
        // Success is a Motion scene: magnet pull / blast into a green flood
        // for payments, the card finale for issue and wipe. The render task
        // plays it; loop() keeps polling shouldAutoDismiss() as before.
        if (successTitle.equalsIgnoreCase("Card Issued"))
            MotionUi::cardDone(Scenes::CardOp::Issue);
        else if (successTitle.equalsIgnoreCase("Card Wiped"))
            MotionUi::cardDone(Scenes::CardOp::Wipe);
        else
            MotionUi::celebrate(sent, amountSats);
    } else {
        // ── ERROR — dark red bg, clear and readable ──
        Motion::stop(); tft.fillScreen(COL_ERROR_DK);

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
