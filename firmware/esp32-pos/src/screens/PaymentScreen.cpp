#include "PaymentScreen.h"
#include "../ui/Theme.h"
#include "../core/InvoiceTtl.h"
#include "../core/QrPolicy.h"
#include <qrcode.h>

uint32_t PaymentScreen::_lastPulse = 0;
int PaymentScreen::_pulsePhase = 0;
uint32_t PaymentScreen::_startedMs = 0;
String PaymentScreen::_timedBolt11;
int PaymentScreen::_lastShownSec = -1;
int PaymentScreen::_ttlSec = InvoiceTtl::FALLBACK_SECONDS;
String PaymentScreen::_stage = "Ready to pay";
bool PaymentScreen::_canCancel = true;

// Fixed zones: amount at top, QR left, card/status right, cancel bottom-right.
// UI is owned by the Arduino task. Workers never access TFT or these fields.
static const int QR_X=12, QR_Y=56, QR_BOX=172;
static const int INFO_X=196, INFO_W=112, CANCEL_Y=194, CANCEL_H=34;
static const uint16_t TEAL=0x2655;

static String groupDigits(long value) {
    const String digits(value);
    String out;
    out.reserve(digits.length()+4);
    for (unsigned i=0;i<digits.length();++i) {
        if (i && (digits.length()-i)%3==0) out+=',';
        out+=digits[i];
    }
    return out;
}

int PaymentScreen::remainingSec(uint32_t now) {
    // Rollover-safe: unsigned subtraction wraps correctly across millis() overflow.
    const uint32_t window = static_cast<uint32_t>(_ttlSec) * 1000U;
    const uint32_t elapsed = now - _startedMs;
    if (elapsed >= window) return 0;
    return static_cast<int>((window - elapsed + 999U) / 1000U);
}

void PaymentScreen::draw(TFT_eSPI& tft,const String& bolt11,long sats,const String& fiat,int ttlSec) {
    if (bolt11!=_timedBolt11) {
        _timedBolt11=bolt11;
        _ttlSec=ttlSec>0 ? ttlSec : InvoiceTtl::FALLBACK_SECONDS;
        _startedMs=millis();
    }
    _stage="Ready to pay"; _canCancel=true;
    _lastShownSec=-1; _lastPulse=millis(); _pulsePhase=0;
    tft.fillScreen(COL_BG);
    drawAmountHeader(tft,sats,fiat);
    drawTimer(tft,remainingSec(millis()));
    tft.drawFastHLine(12,48,296,COL_BORDER);
    drawQR(tft,bolt11,QR_X+QR_BOX/2,QR_Y+QR_BOX/2,QR_BOX);

    // Card/contactless outline uses primitives already available in TFT_eSPI.
    tft.drawRoundRect(220,63,58,38,5,TEAL);
    tft.drawFastHLine(226,73,20,TEAL);
    tft.drawFastHLine(226,78,12,TEAL);
    tft.drawCircle(263,83,5,TEAL);
    tft.setTextFont(FONT_SMALL); tft.setTextDatum(TC_DATUM);
    tft.setTextColor(COL_TEXT,COL_BG);
    tft.drawString("Tap card",INFO_X+INFO_W/2,108);
    tft.setTextColor(COL_MUTED,COL_BG);
    tft.drawString("or scan QR",INFO_X+INFO_W/2,128);
    drawNfcHint(tft,0);
    drawCancelButton(tft);
}

void PaymentScreen::drawCancelButton(TFT_eSPI& tft) {
    _canCancel=true;
    tft.fillRoundRect(INFO_X,CANCEL_Y,INFO_W,CANCEL_H,6,COL_CARD);
    tft.drawRoundRect(INFO_X,CANCEL_Y,INFO_W,CANCEL_H,6,COL_BORDER);
    tft.setTextFont(FONT_SMALL); tft.setTextColor(COL_MUTED,COL_CARD); tft.setTextDatum(MC_DATUM);
    tft.drawString("Cancel",INFO_X+INFO_W/2,CANCEL_Y+CANCEL_H/2);
}

void PaymentScreen::drawAmountHeader(TFT_eSPI& tft,long sats,const String& fiat) {
    tft.setTextDatum(TL_DATUM);
    tft.setTextFont(FONT_MED);
    // Keep monetary values intact. Smaller font is preferable to truncation.
    if (tft.textWidth(fiat)>236) tft.setTextFont(FONT_SMALL);
    tft.setTextColor(COL_TEXT,COL_BG);
    tft.drawString(fiat,12,3);
    tft.setTextFont(FONT_SMALL); tft.setTextColor(COL_ACCENT,COL_BG);
    tft.drawString(groupDigits(sats)+" sats",12,30);
}

void PaymentScreen::drawTimer(TFT_eSPI& tft,int rem) {
    char text[12]; snprintf(text,sizeof(text),"%d:%02d",rem/60,rem%60);
    tft.fillRect(250,3,62,24,COL_BG);
    tft.setTextFont(FONT_SMALL); tft.setTextDatum(TR_DATUM);
    tft.setTextColor(rem<=30 ? COL_ACCENT : COL_MUTED,COL_BG);
    tft.drawString(text,308,7);
    _lastShownSec=rem;
}

void PaymentScreen::drawQR(TFT_eSPI& tft,const String& value,int cx,int cy,int boxPx) {
    String upper=value; upper.toUpperCase();
    const uint8_t version=RicQr::versionForAlphaLength(upper.length());
    if (!version || !RicQr::isAlphanumeric(upper.c_str())) {
        tft.setTextFont(FONT_SMALL); tft.setTextDatum(MC_DATUM);
        tft.setTextColor(COL_ERROR,COL_BG);
        tft.drawString("QR unavailable",cx,cy);
        return;
    }
    static uint8_t buffer[1178];
    static QRCode qr;
    // Exactly one encode. Smallest sufficient version, never overfill a VLA
    // inside the legacy encoder. Four modules of white on ALL sides.
    if (qrcode_initText(&qr,buffer,version,ECC_LOW,upper.c_str())!=0) return;
    const int module=boxPx/(qr.size+8);
    const int total=(qr.size+8)*module;
    const int left=cx-total/2, top=cy-total/2;
    tft.fillRect(left,top,total,total,TFT_WHITE);
    const int x0=left+4*module, y0=top+4*module;
    // Draw only dark modules. White is already present; fewer SPI operations.
    tft.startWrite();
    for (int y=0;y<qr.size;++y) {
        for (int x=0;x<qr.size;++x) {
            if (qrcode_getModule(&qr,x,y)) tft.fillRect(x0+x*module,y0+y*module,module,module,TFT_BLACK);
        }
    }
    tft.endWrite();
}

void PaymentScreen::drawNfcHint(TFT_eSPI& tft,int phase) {
    tft.fillRect(INFO_X,151,INFO_W,35,COL_BG);
    tft.fillCircle(INFO_X+INFO_W/2,155,3,phase ? TEAL : COL_MUTED);
    tft.setTextFont(FONT_SMALL); tft.setTextDatum(TC_DATUM);
    tft.setTextColor(COL_TEXT,COL_BG);
    // Stage labels are bounded UI copy (prompts, decline reasons), never raw
    // server data. Wrap onto two lines inside the info column; clip the rest.
    String first=_stage, second;
    if (tft.textWidth(first)>INFO_W-4) {
        int cut=first.length();
        while (cut>0 && tft.textWidth(first.substring(0,cut))>INFO_W-4) --cut;
        int space=first.lastIndexOf(' ',cut);
        if (space>0) cut=space;
        second=first.substring(cut); second.trim();
        first=first.substring(0,cut);
        while (second.length() && tft.textWidth(second)>INFO_W-4) second.remove(second.length()-1);
    }
    tft.drawString(first,INFO_X+INFO_W/2,second.isEmpty()?166:158);
    if (!second.isEmpty()) tft.drawString(second,INFO_X+INFO_W/2,172);
}

void PaymentScreen::setStage(TFT_eSPI& tft,const String& label,bool canCancel) {
    if (_stage!=label) { _stage=label; drawNfcHint(tft,_pulsePhase); }
    if (_canCancel!=canCancel) {
        _canCancel=canCancel;
        tft.fillRect(INFO_X,CANCEL_Y,INFO_W,CANCEL_H,COL_BG);
        if (canCancel) {
            tft.fillRoundRect(INFO_X,CANCEL_Y,INFO_W,CANCEL_H,6,COL_CARD);
            tft.drawRoundRect(INFO_X,CANCEL_Y,INFO_W,CANCEL_H,6,COL_BORDER);
            tft.setTextFont(FONT_SMALL); tft.setTextDatum(MC_DATUM); tft.setTextColor(COL_MUTED,COL_CARD);
            tft.drawString("Cancel",INFO_X+INFO_W/2,CANCEL_Y+CANCEL_H/2);
        }
    }
}

void PaymentScreen::update(TFT_eSPI& tft) {
    const uint32_t now=millis();
    if (now-_lastPulse>=500) { _lastPulse=now; _pulsePhase^=1; drawNfcHint(tft,_pulsePhase); }
    const int rem=remainingSec(now);
    if (rem!=_lastShownSec) drawTimer(tft,rem);
}
void PaymentScreen::showCardDetected(TFT_eSPI& tft) { setStage(tft,"Hold still",false); }
bool PaymentScreen::handleTouch(int tx,int ty) {
    return _canCancel && tx>=INFO_X && tx<INFO_X+INFO_W && ty>=CANCEL_Y-2 && ty<CANCEL_Y+CANCEL_H+2;
}
