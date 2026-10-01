#include "Motion.h"
#include "Bands.h"
#include "Fb4.h"

// TFT_eSPI.h pulls in the font tables (LOAD_FONT2/4/6 are set in
// platformio.ini), so the scenes render with exactly the panel's own fonts.
static const Fb4Font kFont2{widtbl_f16, (const uint8_t* const*)chrtbl_f16, chr_hgt_f16, baseline_f16, false};
static const Fb4Font kFont4{widtbl_f32, (const uint8_t* const*)chrtbl_f32, chr_hgt_f32, baseline_f32, true};
static const Fb4Font kFont6{widtbl_f64, (const uint8_t* const*)chrtbl_f64, chr_hgt_f64, baseline_f64, true};

namespace Motion {

namespace {

constexpr uint32_t kStackBytes = 6144;   // ESP-IDF stack depth is in bytes

TFT_eSPI*         g_tft = nullptr;
SemaphoreHandle_t g_mx = nullptr;
StaticSemaphore_t g_mxBuf;
TaskHandle_t      g_task = nullptr;
StaticTask_t      g_tcb;
StackType_t       g_stack[kStackBytes];

uint8_t  g_band[Bands::kBandBytes];
uint16_t g_line[320];
Fb4      g_fb;

// Guarded by g_mx.
Scenes::Scene* g_scene = nullptr;
uint32_t g_t0 = 0;
uint32_t g_lastT = 0;
bool     g_first = false;
bool     g_done = false;
// Stats for the serial log (one line per scene).
uint32_t g_frames = 0, g_busyMs = 0;

void present(const Fb4& fb) {
    uint16_t pal[16];
    for (int i = 0; i < 16; ++i) pal[i] = (uint16_t)((fb.pal[i] >> 8) | (fb.pal[i] << 8));  // panel byte order
    g_tft->setAddrWindow(fb.x0, fb.y0, fb.w, fb.h);
    for (int y = 0; y < fb.h; ++y) {
        const uint8_t* row = fb.data() + y * fb.stride;
        int x = 0;
        for (; x + 1 < fb.w; x += 2) {
            const uint8_t b = row[x >> 1];
            g_line[x] = pal[b >> 4];
            g_line[x + 1] = pal[b & 15];
        }
        if (x < fb.w) g_line[x] = pal[row[x >> 1] >> 4];
        g_tft->pushPixels(g_line, (uint32_t)fb.w);
    }
}

void logScene() {
    if (g_scene && g_frames)
        Serial.printf("[MOTION] scene done: %u frames, avg %u ms/frame\n",
                      (unsigned)g_frames, (unsigned)(g_busyMs / g_frames));
    g_frames = 0; g_busyMs = 0;
}

void task(void*) {
    for (;;) {
        xSemaphoreTake(g_mx, portMAX_DELAY);
        Scenes::Scene* s = g_scene;
        const uint32_t start = millis();
        uint16_t frameMs = 33;
        bool idle = (s == nullptr) || g_done;
        if (!idle) {
            frameMs = s->frameMs();
            const uint32_t dur = s->duration();
            uint32_t t = start - g_t0;
            if (dur && t > dur) t = dur;
            const Scenes::Rect r = g_first ? Scenes::Rect{0, 0, 320, 240} : s->dirty(t);
            g_tft->startWrite();
            Bands::render(g_fb, *s, t, r, present);
            g_tft->endWrite();
            g_first = false;
            g_lastT = t;
            g_frames++;
            g_busyMs += millis() - start;
            if (dur && t >= dur) { g_done = true; logScene(); }
        }
        xSemaphoreGive(g_mx);

        if (idle) {
            ulTaskNotifyTake(pdTRUE, portMAX_DELAY);   // woken by showLocked()
        } else {
            const uint32_t spent = millis() - start;
            // Always yield at least 2 ms so IDLE0 runs and the task WDT stays fed.
            vTaskDelay(pdMS_TO_TICKS(spent + 2 < frameMs ? frameMs - spent : 2));
        }
    }
}

} // namespace

void begin(TFT_eSPI& tft) {
    if (g_task) return;
    g_tft = &tft;
    g_fb.attach(g_band, sizeof(g_band));
    Scenes::setFonts(&kFont2, &kFont4, &kFont6);
    g_mx = xSemaphoreCreateMutexStatic(&g_mxBuf);
    // Core 0 next to the WiFi stack (which preempts it); the Arduino loop and
    // its blocking network/NFC calls stay on core 1.
    g_task = xTaskCreateStaticPinnedToCore(task, "motion", kStackBytes, nullptr, 1, g_stack, &g_tcb, 0);
}

void lock()   { if (g_mx) xSemaphoreTake(g_mx, portMAX_DELAY); }
void unlock() { if (g_mx) xSemaphoreGive(g_mx); }

void showLocked(Scenes::Scene* s, bool keepClock) {
    if (!g_task) return;
    const bool same = (s == g_scene) && !g_done;
    if (!(same && keepClock)) {
        if (g_scene != s) logScene();
        g_t0 = millis();
        g_lastT = 0;
    }
    g_scene = s;
    g_first = true;
    g_done = false;
    xTaskNotifyGive(g_task);
}

void stop() {
    if (!g_mx) return;
    xSemaphoreTake(g_mx, portMAX_DELAY);    // waits for the frame in flight
    if (g_scene && !g_done) logScene();
    g_scene = nullptr;
    g_done = false;
    xSemaphoreGive(g_mx);
}

Scenes::Scene* current() { return g_scene; }
uint32_t elapsedMs() { return g_scene ? millis() - g_t0 : 0; }

} // namespace Motion
