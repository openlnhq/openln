// Host preview for the RIC motion scenes.
//
// Renders the real scene code (src/motion) through the same banded engine the
// device uses, into a simulated 320x240 RGB565 panel that persists between
// frames exactly like the TFT does (first frame full screen, then only each
// scene's dirty rect). Emits raw RGB24 frames on stdout for ffmpeg.
//
//   g++ -std=c++17 -O2 -I src -I <TFT_eSPI dir> tools/motion-preview/preview.cpp
//       src/motion/Scenes.cpp -o /tmp/ric-preview
//   /tmp/ric-preview receive | ffmpeg -f rawvideo -pix_fmt rgb24 -s 320x240 -r 30 -i - out.mp4
//   /tmp/ric-preview receive --still 2500 > frame.ppm
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>
#include <functional>
#include <string>

#define PROGMEM
#include <Fonts/Font16.c>
#include <Fonts/Font32rle.c>
#include <Fonts/Font64rle.c>

#include "motion/Fb4.h"
#include "motion/Scenes.h"
#include "motion/Bands.h"

using namespace Scenes;

static const Fb4Font kFont2{widtbl_f16, (const uint8_t* const*)chrtbl_f16, 16, 13, false};
static const Fb4Font kFont4{widtbl_f32, (const uint8_t* const*)chrtbl_f32, 26, 19, true};
static const Fb4Font kFont6{widtbl_f64, (const uint8_t* const*)chrtbl_f64, 48, 36, true};

static uint8_t bandMem[Bands::kBandBytes];   // same capacity as the device engine
static uint16_t panel[240][320];

static void present(const Fb4& fb) {
    for (int y = 0; y < fb.h; ++y)
        for (int x = 0; x < fb.w; ++x) {
            const uint8_t b = fb.data()[y * fb.stride + (x >> 1)];
            const uint8_t c = (x & 1) ? (b & 15) : (b >> 4);
            panel[fb.y0 + y][fb.x0 + x] = fb.pal[c];
        }
}

static void emit(FILE* out) {
    static uint8_t rgb[240 * 320 * 3];
    for (int y = 0; y < 240; ++y)
        for (int x = 0; x < 320; ++x) {
            const uint16_t c = panel[y][x];
            uint8_t* p = &rgb[(y * 320 + x) * 3];
            p[0] = (uint8_t)(((c >> 11) & 31) * 255 / 31);
            p[1] = (uint8_t)(((c >> 5) & 63) * 255 / 63);
            p[2] = (uint8_t)((c & 31) * 255 / 31);
        }
    fwrite(rgb, 1, sizeof(rgb), out);
}

// A timeline segment: a scene shown for `ms`, with an optional per-frame hook
// (e.g. advance the card step or the download percent).
struct Seg {
    Scene* scene;
    uint32_t ms;
    std::function<void(uint32_t)> hook;
    bool fresh;   // full repaint on entry (a new screen)
    Seg(Scene* s, uint32_t m, std::function<void(uint32_t)> h = nullptr, bool f = true)
        : scene(s), ms(m), hook(h), fresh(f) {}
};

static void run(std::vector<Seg>& segs, int stillAt) {
    Fb4 fb; fb.attach(bandMem, sizeof(bandMem));
    uint32_t clock = 0;
    for (auto& s : segs) {
        const uint32_t dur = s.scene->duration();
        for (uint32_t t = 0; t < s.ms; t += 33, clock += 33) {
            if (s.hook) s.hook(t);
            uint32_t st = dur && t > dur ? dur : t;
            if (t == 0 && s.fresh) Bands::render(fb, *s.scene, st, Rect{0, 0, 320, 240}, present);
            else if (!(dur && t > dur + 33)) Bands::render(fb, *s.scene, st, s.scene->dirty(st), present);
            if (stillAt < 0) emit(stdout);
            else if ((int)clock >= stillAt) {
                printf("P6\n320 240\n255\n"); fflush(stdout); emit(stdout); return;
            }
        }
    }
}

int main(int argc, char** argv) {
    setFonts(&kFont2, &kFont4, &kFont6);
    const std::string which = argc > 1 ? argv[1] : "receive";
    int still = -1;
    for (int i = 2; i + 1 < argc; ++i) if (!strcmp(argv[i], "--still")) still = atoi(argv[i + 1]);

    static MachineScene work, confirm, commit, stall, send;
    static CelebrateScene cel;
    static CardWorkScene cardWork;
    static CardDoneScene cardDone;
    static ProvisionScene prov;
    static ConnectScene join, link, retry;
    static UpdateScene check, dl, ok;

    std::vector<Seg> segs;
    if (which == "receive") {
        work.set("Processing payment", "One moment", Mood::Work);
        confirm.set("Confirming payment", "Settling over Lightning", Mood::Receive, 35);
        commit.set("Confirming payment", "Finishing up. Do not tap again.", Mood::Receive, 35, true);
        cel.set(Celebration::Received, 35, "Payment received");
        segs = {{&work, 1000}, {&confirm, 3000}, {&commit, 1400}, {&cel, 3200}};
    } else if (which == "receive-big") {
        confirm.set("Confirming payment", "Settling over Lightning", Mood::Receive, 125000);
        cel.set(Celebration::Received, 125000, "Payment received");
        segs = {{&confirm, 1500}, {&cel, 3000}};
    } else if (which == "cel-recv") {
        cel.set(Celebration::Received, 35, "Payment received");
        segs = {{&cel, 2400}};
    } else if (which == "cel-sent") {
        cel.set(Celebration::Sent, 2100, "Payment sent");
        segs = {{&cel, 2400}};
    } else if (which == "send") {
        send.set("Sending payment", "To the tapped card", Mood::Send, 2100);
        cel.set(Celebration::Sent, 2100, "Payment sent");
        segs = {{&send, 2600}, {&cel, 3200}};
    } else if (which == "stall") {
        stall.set("Confirming payment", "Reconnecting...", Mood::Stall, 35);
        segs = {{&stall, 3000}};
    } else if (which == "card-issue") {
        cardWork.set(CardOp::Issue);
        cardDone.set(CardOp::Issue);
        segs = {{&cardWork, 2800, [](uint32_t t) { cardWork.setStep((int)(t / 800)); }}, {&cardDone, 2800}};
    } else if (which == "card-wipe") {
        cardWork.set(CardOp::Wipe);
        cardDone.set(CardOp::Wipe);
        segs = {{&cardWork, 3200, [](uint32_t t) { cardWork.setStep((int)(t / 700)); }}, {&cardDone, 2800}};
    } else if (which == "provision") {
        prov.set("RIC-7F3A");
        segs = {{&prov, 4800}};
    } else if (which == "connect") {
        join.set(LinkPhase::Join, "Connecting to WiFi", "Samui Beach Cafe", true);
        link.set(LinkPhase::Link, "Linking to openLN", "Secure connection", false);
        retry.set(LinkPhase::Retry, "Reconnecting to openLN", "Saved settings kept. Retrying.", false);
        segs = {{&join, 2600}, {&link, 2200}, {&retry, 2200}};
    } else if (which == "update") {
        check.set(UpdatePhase::Checking, "Checking updates", "Secure connection to openLN");
        dl.set(UpdatePhase::Download, "Updating firmware", "v1.0.13 to v1.0.14", "Do not disconnect power");
        ok.set(UpdatePhase::Verified, "Update verified", "Restarting device");
        segs = {{&check, 1600}, {&dl, 4200, [](uint32_t t) { dl.setPercent((int)(t * 100 / 3800)); }}, {&ok, 1500}};
    } else { fprintf(stderr, "unknown scenario\n"); return 2; }
    run(segs, still);
    return 0;
}
