#pragma once
#include "Arduino.h"
#include <array>
#include <filesystem>
#include <functional>
#include <limits>
#include <stdexcept>

#define TFT_BLACK 0x0000
#define TFT_WHITE 0xFFFF
#define TFT_RED 0xF800
#define TFT_GREEN 0x07E0
#define TFT_BLUE 0x001F
#define TFT_ORANGE 0xFDA0
#define TL_DATUM 0
#define TC_DATUM 1
#define TR_DATUM 2
#define ML_DATUM 3
#define CL_DATUM 3
#define MC_DATUM 4
#define CC_DATUM 4
#define MR_DATUM 5
#define CR_DATUM 5
#define BL_DATUM 6
#define BC_DATUM 7
#define BR_DATUM 8
#define L_BASELINE 9
#define C_BASELINE 10
#define R_BASELINE 11
#define _swap_int32_t(a,b) std::swap(a,b)

inline uint8_t pgm_read_byte(const void* p) { return *static_cast<const uint8_t*>(p); }
inline uintptr_t pgm_read_dword(const void* p) {
    uintptr_t value; std::memcpy(&value, p, sizeof(value)); return value;
}

namespace host {
struct Rect { int x = 0, y = 0, w = 0, h = 0; };
struct Op {
    std::string kind, text;
    Rect rect, ink;
    uint32_t ms = 0;
    uint16_t color = 0, background = 0;
    int font = 0, size = 1, datum = 0;
    int qrX = -1, qrY = -1;
    size_t inkPixels = 0;
};
struct QrObservation {
    int version = 0, size = 0, ecc = 0;
    std::string payload, modules;
};
extern QrObservation qr;
extern std::function<void(uint32_t)> delayObserver;
std::string jsonQuote(const std::string& value);
}

// The real library's software drawing methods are imported at build time.
// Only bus writes, time, Arduino String and operation tracing live here.
class TFT_eSPI {
public:
    static constexpr int WIDTH = 320, HEIGHT = 240;
    std::vector<uint16_t> pixels;
    std::vector<int> owners;
    std::vector<host::Op> operations;

    TFT_eSPI();
    int16_t width() const { return WIDTH; }
    int16_t height() const { return HEIGHT; }
    void setTextFont(uint8_t font) {
        if (font != 2 && font != 4 && font != 6)
            throw std::runtime_error("Host adapter: unloaded/unsupported font " + std::to_string(font));
        textfont = font;
    }
    void setTextSize(uint8_t size) { textsize = size ? size : 1; }
    void setTextDatum(uint8_t datum) { textdatum = datum; }
    uint8_t getTextDatum() const { return textdatum; }
    void setTextPadding(uint16_t padding) { padX = padding; }
    void setTextColor(uint32_t foreground, uint32_t background) { textcolor = foreground; textbgcolor = background; }
    void setTextColor(uint32_t foreground) { setTextColor(foreground, foreground); }
    int16_t textWidth(const char* text, uint8_t font);
    int16_t textWidth(const char* text) { return textWidth(text, textfont); }
    int16_t textWidth(const String& text) { return textWidth(text.c_str(), textfont); }
    int16_t textWidth(const String& text, uint8_t font) { return textWidth(text.c_str(), font); }
    int16_t fontHeight(int16_t font);
    int16_t fontHeight() { return fontHeight(textfont); }
    int16_t drawString(const char* text, int32_t x, int32_t y, uint8_t font);
    int16_t drawString(const char* text, int32_t x, int32_t y) { return drawString(text, x, y, textfont); }
    int16_t drawString(const String& text, int32_t x, int32_t y) { return drawString(text.c_str(), x, y, textfont); }
    int16_t drawString(const String& text, int32_t x, int32_t y, uint8_t font) { return drawString(text.c_str(), x, y, font); }
    int16_t drawChar(uint16_t unicode, int32_t x, int32_t y, uint8_t font);
    int16_t drawNumber(long value, int32_t x, int32_t y, uint8_t font) { return drawString(String(value), x, y, font); }
    int16_t drawNumber(long value, int32_t x, int32_t y) { return drawNumber(value, x, y, textfont); }

    // SPI transaction boundaries have no host bus to lock. Raster calls still execute.
    void startWrite() {}
    void endWrite() {}
    void fillScreen(uint32_t color);
    void fillRect(int32_t x, int32_t y, int32_t w, int32_t h, uint32_t color);
    void drawRect(int32_t x, int32_t y, int32_t w, int32_t h, uint32_t color);
    void fillRoundRect(int32_t x, int32_t y, int32_t w, int32_t h, int32_t r, uint32_t color);
    void drawRoundRect(int32_t x, int32_t y, int32_t w, int32_t h, int32_t r, uint32_t color);
    void drawCircle(int32_t x, int32_t y, int32_t r, uint32_t color);
    void fillCircle(int32_t x, int32_t y, int32_t r, uint32_t color);
    void drawCircleHelper(int32_t x, int32_t y, int32_t r, uint8_t corners, uint32_t color);
    void fillCircleHelper(int32_t x, int32_t y, int32_t r, uint8_t corners, int32_t delta, uint32_t color);
    void drawFastHLine(int32_t x, int32_t y, int32_t w, uint32_t color);
    void drawFastVLine(int32_t x, int32_t y, int32_t h, uint32_t color);
    void drawPixel(int32_t x, int32_t y, uint32_t color);
    uint16_t readPixel(int32_t x, int32_t y) const;
    void drawLine(int32_t x0, int32_t y0, int32_t x1, int32_t y1, uint32_t color);
    void drawTriangle(int32_t x0, int32_t y0, int32_t x1, int32_t y1, int32_t x2, int32_t y2, uint32_t color);
    void fillTriangle(int32_t x0, int32_t y0, int32_t x1, int32_t y1, int32_t x2, int32_t y2, uint32_t color);

    void save(const std::filesystem::path& directory, const std::string& name) const;
    std::string lastTimer() const;

private:
    uint8_t textfont = 2, textsize = 1, textdatum = TL_DATUM;
    uint16_t textcolor = TFT_WHITE, textbgcolor = TFT_BLACK, padX = 0;
    bool isDigits = false, _utf8 = true, _vpOoB = false;
    bool inTransaction = false, lockTransaction = false;
    int32_t _xDatum = 0, _yDatum = 0, _vpX = 0, _vpY = 0, _vpW = WIDTH, _vpH = HEIGHT;
    int depth_ = 0, owner_ = -1;
    int windowX_ = 0, windowY_ = 0, windowW_ = 0, windowH_ = 0, windowOffset_ = 0;
    uint16_t decodeUTF8(uint8_t* buffer, uint16_t* index, uint16_t remaining);
    void begin_tft_write() {}
    void end_tft_write() {}
    void setWindow(int32_t x0, int32_t y0, int32_t x1, int32_t y1);
    void tft_Write_16(uint16_t color);
    void pushBlock(uint16_t color, uint32_t count);
    void put(int32_t x, int32_t y, uint16_t color);
    void span(int x, int y, int width, int height, uint16_t color);
    struct TraceScope {
        TFT_eSPI& tft;
        int priorOwner;
        bool outer;
        explicit TraceScope(TFT_eSPI& screen);
        TraceScope(TFT_eSPI& screen, const char* kind, int x, int y, int w, int h, uint32_t color);
        ~TraceScope();
        void text(const char* value, int x, int y, int w, int h, uint8_t font);
    };
};
