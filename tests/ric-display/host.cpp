#include <TFT_eSPI.h>
#include <qrcode.h>
#include <fstream>
#include <regex>

namespace host {
uint32_t nowMs = 0;
std::vector<uint32_t> delays;
std::function<void(uint32_t)> delayObserver;
QrObservation qr;
static const uint8_t* encodedModules = nullptr;
static bool qrQueryPending = false;
static int queriedX = -1, queriedY = -1;
void resetClock(uint32_t now) { nowMs = now; delays.clear(); }
std::string jsonQuote(const std::string& value) {
    std::ostringstream out; out << '"';
    for (unsigned char ch : value) {
        if (ch == '"' || ch == '\\') out << '\\' << ch;
        else if (ch < 32) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << int(ch) << std::dec;
        else out << ch;
    }
    out << '"'; return out.str();
}
}

void delay(uint32_t milliseconds) {
    host::delays.push_back(milliseconds);
    if (host::delayObserver) host::delayObserver(milliseconds);
    host::nowMs += milliseconds; // Record the firmware's actual wait, without sleeping the host.
}

// Linker observation only: the installed C encoder still executes unchanged.
extern "C" int8_t __real_qrcode_initText(QRCode*, uint8_t*, uint8_t, uint8_t, const char*);
extern "C" bool __real_qrcode_getModule(QRCode*, uint8_t, uint8_t);
extern "C" int8_t __wrap_qrcode_initText(QRCode* qr, uint8_t* buffer, uint8_t version,
                                         uint8_t ecc, const char* payload) {
    host::qrQueryPending = false;
    host::encodedModules = nullptr;
    int8_t status = __real_qrcode_initText(qr, buffer, version, ecc, payload);
    if (status == 0) {
        host::encodedModules = qr->modules;
        host::qr = {qr->version, qr->size, qr->ecc, payload, ""};
        for (int y = 0; y < qr->size; ++y)
            for (int x = 0; x < qr->size; ++x)
                host::qr.modules += __real_qrcode_getModule(qr, x, y) ? '1' : '0';
    }
    return status;
}
extern "C" bool __wrap_qrcode_getModule(QRCode* qr, uint8_t x, uint8_t y) {
    // Pair a real firmware module query with the following TFT primitive.
    // Both dark-only and black/white painting work without inferring position
    // from an arbitrary black rectangle or changing the encoder result.
    host::qrQueryPending = qr->modules == host::encodedModules && host::qr.size > 0;
    host::queriedX = x; host::queriedY = y;
    return __real_qrcode_getModule(qr, x, y);
}

TFT_eSPI::TFT_eSPI() : pixels(WIDTH * HEIGHT, TFT_BLACK), owners(WIDTH * HEIGHT, -1) {}
TFT_eSPI::TraceScope::TraceScope(TFT_eSPI& screen)
    : tft(screen), priorOwner(screen.owner_), outer(screen.depth_++ == 0) {}
TFT_eSPI::TraceScope::TraceScope(TFT_eSPI& screen, const char* kind, int x, int y, int w, int h, uint32_t color)
    : TraceScope(screen) {
    if (outer) {
        if (std::strcmp(kind, "fillRect") != 0) host::qrQueryPending = false;
        host::Op operation;
        operation.kind = kind; operation.rect = {x, y, w, h}; operation.color = color;
        operation.ms = millis();
        tft.owner_ = tft.operations.size(); tft.operations.push_back(operation);
    }
}
TFT_eSPI::TraceScope::~TraceScope() { --tft.depth_; tft.owner_ = priorOwner; }
void TFT_eSPI::TraceScope::text(const char* value, int x, int y, int w, int h, uint8_t font) {
    if (!outer) return;
    host::qrQueryPending = false;
    host::Op operation;
    operation.kind = "text"; operation.text = value; operation.rect = {x, y, w, h};
    operation.color = tft.textcolor; operation.background = tft.textbgcolor;
    operation.font = font; operation.size = tft.textsize; operation.datum = tft.textdatum;
    operation.ms = millis();
    tft.owner_ = tft.operations.size(); tft.operations.push_back(operation);
}

void TFT_eSPI::put(int32_t x, int32_t y, uint16_t color) {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
    auto index = y * WIDTH + x;
    pixels[index] = color; owners[index] = owner_;
    if (owner_ >= 0) {
        auto& op = operations[owner_];
        if (op.kind == "text" && color == op.color) {
            if (op.inkPixels++ == 0) op.ink = {x, y, 1, 1};
            else {
                int right = std::max(op.ink.x + op.ink.w, x + 1);
                int bottom = std::max(op.ink.y + op.ink.h, y + 1);
                op.ink.x = std::min(op.ink.x, int(x)); op.ink.y = std::min(op.ink.y, int(y));
                op.ink.w = right - op.ink.x; op.ink.h = bottom - op.ink.y;
            }
        }
    }
}
void TFT_eSPI::span(int x, int y, int w, int h, uint16_t color) {
    for (int yy = std::max(0, y); yy < std::min(HEIGHT, y + h); ++yy)
        for (int xx = std::max(0, x); xx < std::min(WIDTH, x + w); ++xx) put(xx, yy, color);
}
void TFT_eSPI::fillScreen(uint32_t color) {
    TraceScope trace(*this, "fillScreen", 0, 0, WIDTH, HEIGHT, color);
    span(0, 0, WIDTH, HEIGHT, color);
}
void TFT_eSPI::fillRect(int32_t x, int32_t y, int32_t w, int32_t h, uint32_t color) {
    TraceScope trace(*this, "fillRect", x, y, w, h, color);
    if (trace.outer && host::qrQueryPending) {
        operations[owner_].qrX = host::queriedX;
        operations[owner_].qrY = host::queriedY;
    }
    host::qrQueryPending = false;
    span(x, y, w, h, color);
}
void TFT_eSPI::drawFastHLine(int32_t x, int32_t y, int32_t w, uint32_t color) {
    TraceScope trace(*this, "drawFastHLine", x, y, w, 1, color); span(x, y, w, 1, color);
}
void TFT_eSPI::drawFastVLine(int32_t x, int32_t y, int32_t h, uint32_t color) {
    TraceScope trace(*this, "drawFastVLine", x, y, 1, h, color); span(x, y, 1, h, color);
}
void TFT_eSPI::drawPixel(int32_t x, int32_t y, uint32_t color) {
    TraceScope trace(*this, "drawPixel", x, y, 1, 1, color); put(x, y, color);
}
uint16_t TFT_eSPI::readPixel(int32_t x, int32_t y) const {
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) throw std::out_of_range("pixel outside framebuffer");
    return pixels[y * WIDTH + x];
}
void TFT_eSPI::setWindow(int32_t x0, int32_t y0, int32_t x1, int32_t y1) {
    windowX_ = x0; windowY_ = y0; windowW_ = x1 - x0 + 1; windowH_ = y1 - y0 + 1; windowOffset_ = 0;
}
void TFT_eSPI::tft_Write_16(uint16_t color) {
    if (windowW_ <= 0 || windowH_ <= 0) throw std::runtime_error("invalid TFT write window");
    if (windowOffset_ >= windowW_ * windowH_) windowOffset_ = 0;
    put(windowX_ + windowOffset_ % windowW_, windowY_ + windowOffset_ / windowW_, color);
    ++windowOffset_;
}
void TFT_eSPI::pushBlock(uint16_t color, uint32_t count) { while (count--) tft_Write_16(color); }

static void rectJson(std::ostream& out, const host::Rect& rect) {
    out << "{\"x\":" << rect.x << ",\"y\":" << rect.y << ",\"w\":" << rect.w << ",\"h\":" << rect.h << '}';
}
void TFT_eSPI::save(const std::filesystem::path& directory, const std::string& name) const {
    std::filesystem::create_directories(directory);
    std::ofstream ppm(directory / (name + ".ppm"), std::ios::binary);
    ppm << "P6\n" << WIDTH << ' ' << HEIGHT << "\n255\n";
    for (uint16_t rgb : pixels) {
        unsigned r = (rgb >> 11) & 31, g = (rgb >> 5) & 63, b = rgb & 31;
        const char pixel[3] = {char((r << 3) | (r >> 2)), char((g << 2) | (g >> 4)), char((b << 3) | (b >> 2))};
        ppm.write(pixel, 3);
    }
    std::ofstream trace(directory / (name + ".json"));
    trace << "{\"name\":" << host::jsonQuote(name) << ",\"width\":" << WIDTH << ",\"height\":" << HEIGHT
          << ",\"millis\":" << millis() << ",\"operations\":[";
    for (size_t i = 0; i < operations.size(); ++i) {
        if (i) trace << ',';
        const auto& op = operations[i];
        size_t visibleInk = 0;
        if (op.kind == "text") for (size_t px = 0; px < pixels.size(); ++px)
            if (owners[px] == int(i) && pixels[px] == op.color) ++visibleInk;
        trace << "{\"id\":" << i << ",\"kind\":" << host::jsonQuote(op.kind)
              << ",\"rect\":"; rectJson(trace, op.rect);
        trace << ",\"color\":" << op.color << ",\"millis\":" << op.ms;
        if (op.qrX >= 0)
            trace << ",\"qrModule\":{\"x\":" << op.qrX << ",\"y\":" << op.qrY << '}';
        if (op.kind == "text") {
            trace << ",\"text\":" << host::jsonQuote(op.text) << ",\"font\":" << op.font
                  << ",\"size\":" << op.size << ",\"datum\":" << op.datum << ",\"background\":" << op.background
                  << ",\"inkPixels\":" << op.inkPixels << ",\"visibleInkPixels\":" << visibleInk << ",\"inkRect\":";
            rectJson(trace, op.ink);
        }
        trace << '}';
    }
    trace << "],\"qr\":{\"version\":" << host::qr.version << ",\"size\":" << host::qr.size
          << ",\"ecc\":" << host::qr.ecc << ",\"payload\":" << host::jsonQuote(host::qr.payload)
          << ",\"modules\":" << host::jsonQuote(host::qr.modules) << "}}\n";
    if (!ppm || !trace) throw std::runtime_error("failed to write host artifacts");
}
std::string TFT_eSPI::lastTimer() const {
    static const std::regex timer("^[0-9]+:[0-9]{2}$");
    for (auto it = operations.rbegin(); it != operations.rend(); ++it)
        if (it->kind == "text" && std::regex_match(it->text, timer)) return it->text;
    return "";
}
