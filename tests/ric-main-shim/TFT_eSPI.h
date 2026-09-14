#pragma once
#include "Arduino.h"
#define TFT_BLACK 0
#define TFT_WHITE 0xffff
#define TFT_RED 0xf800
#define TL_DATUM 0
#define TC_DATUM 1
#define TR_DATUM 2
#define MC_DATUM 4
class TFT_eSPI {
public:
    void init(){} void setRotation(int){} void invertDisplay(bool){}
    int width(){return 320;} int height(){return 240;}
    void setTextDatum(int){} void setTextFont(int){} void setTextSize(int){}
    void setTextColor(uint32_t,uint32_t=0){}
    int drawString(const String& s,int,int){RicMainShim::ui();RicMainShim::displayText.emplace_back(s.c_str());return s.length();}
    static uint16_t color565(uint8_t r,uint8_t g,uint8_t b){return (uint16_t(r&0xf8)<<8)|(uint16_t(g&0xfc)<<3)|(b>>3);}
    void fillScreen(uint32_t){RicMainShim::ui();}
    void fillRect(int,int,int,int,uint32_t){RicMainShim::ui();}
    void drawRect(int,int,int,int,uint32_t){RicMainShim::ui();}
    void fillRoundRect(int,int,int,int,int,uint32_t){RicMainShim::ui();}
    void drawRoundRect(int,int,int,int,int,uint32_t){RicMainShim::ui();}
    void fillCircle(int,int,int,uint32_t){RicMainShim::ui();}
    void drawCircle(int,int,int,uint32_t){RicMainShim::ui();}
};
