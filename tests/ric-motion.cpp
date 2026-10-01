#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <initializer_list>
#include "core/MotionMath.h"
#include "motion/CardSteps.h"
#include "motion/Bands.h"
#include "motion/Scenes.cpp"   // unity build: the harness compiles one file

// Native tests for the RIC motion engine (no Arduino deps).
// Run by tests/ric-firmware-policy.test.mjs with g++ -std=c++17 -Wall -Wextra -Werror.
//
// What matters on the device:
//  * banded rendering through the 8 KB buffer is pixel-identical to a single
//    full frame (no seams between bands);
//  * the dirty-rect contract: pixels outside dirty(t) never change after the
//    first frame, because the device only repaints dirty(t);
//  * money on screen: the count-up never overshoots and lands exactly;
//  * the Cancel button is drawn where main.cpp hit-tests it;
//  * NfcWriter's progress labels map onto the step tracker.

using namespace Scenes;
using namespace MotionMath;

// Solid stub glyphs stand in for TFT_eSPI's fonts so text exercises the same
// palette slots and layout as on the device.
static uint8_t kSolid[512];
static uint8_t kWidths[96];
static const uint8_t* kGlyphs[96];
static const Fb4Font kF2{kWidths, kGlyphs, 16, 13, false};
static const Fb4Font kF4{kWidths, kGlyphs, 26, 19, true};
static const Fb4Font kF6{kWidths, kGlyphs, 48, 36, true};

static uint8_t g_full[320 * 240 / 2];
static uint8_t g_band[Bands::kBandBytes];
static uint16_t g_ref[240][320], g_banded[240][320], g_first[240][320];

static void fullFrame(Scene& s, uint32_t t, uint16_t out[240][320]) {
    Fb4 fb; fb.attach(g_full, sizeof(g_full));
    s.palette(fb, t);
    fb.setWindow(0, 0, 320, 240); fb.noClip(); fb.clear(s.background());
    s.render(fb, t);
    for (int y = 0; y < 240; ++y)
        for (int x = 0; x < 320; ++x) out[y][x] = fb.pal[fb.get(x, y)];
}

static void bandedFrame(Scene& s, uint32_t t, Rect r, uint16_t out[240][320]) {
    Fb4 fb; fb.attach(g_band, sizeof(g_band));
    Bands::render(fb, s, t, r, [&](const Fb4& b) {
        for (int y = 0; y < b.h; ++y)
            for (int x = 0; x < b.w; ++x) {
                const uint8_t v = b.data()[y * b.stride + (x >> 1)];
                out[b.y0 + y][b.x0 + x] = b.pal[(x & 1) ? (v & 15) : (v >> 4)];
            }
    });
}

static int failures = 0;
#define CHECK(cond, ...) do { if (!(cond)) { std::printf(__VA_ARGS__); std::printf("\n"); ++failures; } } while (0)

static void checkScene(const char* name, Scene& s, uint32_t until, uint32_t step) {
    fullFrame(s, 0, g_first);
    for (uint32_t t = 0; t <= until; t += step) {
        fullFrame(s, t, g_ref);
        // Band seams: a full-screen banded render equals the single frame.
        bandedFrame(s, t, Rect{0, 0, 320, 240}, g_banded);
        int seam = 0;
        for (int y = 0; y < 240; ++y)
            for (int x = 0; x < 320; ++x) seam += g_ref[y][x] != g_banded[y][x];
        CHECK(seam == 0, "%s t=%u: banded render differs in %d px", name, (unsigned)t, seam);

        // Dirty contract: outside dirty(t) the frame equals the first frame.
        const Rect d = s.dirty(t);
        int stale = 0, fx = -1, fy = -1;
        for (int y = 0; y < 240; ++y)
            for (int x = 0; x < 320; ++x) {
                const bool inside = x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h;
                if (!inside && g_ref[y][x] != g_first[y][x]) { if (!stale) { fx = x; fy = y; } ++stale; }
            }
        CHECK(stale == 0, "%s t=%u: %d px change outside dirty() (first at %d,%d)",
              name, (unsigned)t, stale, fx, fy);
    }
}

int main() {
    memset(kSolid, 0xFF, sizeof(kSolid));
    for (int i = 0; i < 96; ++i) { kWidths[i] = 8; kGlyphs[i] = kSolid; }
    setFonts(&kF2, &kF4, &kF6);

    // ── MotionMath ─────────────────────────────────────────────────────────
    assert(clamp01(-1.f) == 0.f && clamp01(2.f) == 1.f);
    assert(phase(50, 100, 200) == 0.f && phase(400, 100, 200) == 1.f);
    assert(std::fabs(phase(200, 100, 200) - 0.5f) < 1e-6f);
    for (float (*e)(float) : {easeInCubic, easeOutCubic, easeInOutSine, easeOutQuad}) {
        assert(std::fabs(e(0.f)) < 1e-6f && std::fabs(e(1.f) - 1.f) < 1e-6f);
    }
    assert(std::fabs(easeOutBack(1.f) - 1.f) < 1e-5f && easeOutBack(0.7f) > 1.f);   // overshoots, lands
    assert(hex565(0xFFFFFF) == 0xFFFF && hex565(0x000000) == 0 && hex565(0xFF0000) == 0xF800);
    assert(mix(0x000000, 0xFFFFFF, 0.f) == 0 && mix(0x000000, 0xFFFFFF, 1.f) == 0xFFFF);

    // Count-up: monotonic, never above the amount, exact at the end.
    for (long amount : {1L, 35L, 999L, 2100L, 125000L, 21000000L}) {
        long prev = 0;
        for (int i = 0; i <= 100; ++i) {
            const long v = countUp(amount, i / 100.f);
            assert(v >= prev && v <= amount);
            prev = v;
        }
        assert(countUp(amount, 1.f) == amount && countUp(amount, 3.f) == amount);
    }
    assert(countUp(0, 0.5f) == 0 && countUp(-5, 1.f) == 0);

    char buf[32];
    groupDigits(0, buf, sizeof(buf));        assert(!strcmp(buf, "0"));
    groupDigits(35, buf, sizeof(buf));       assert(!strcmp(buf, "35"));
    groupDigits(2100, buf, sizeof(buf));     assert(!strcmp(buf, "2,100"));
    groupDigits(125000, buf, sizeof(buf));   assert(!strcmp(buf, "125,000"));
    groupDigits(100000000, buf, sizeof(buf));assert(!strcmp(buf, "100,000,000"));

    // Gear mesh: when a tooth of A faces B, B shows a gap (half pitch).
    for (int k = 0; k < 6; ++k) {
        const int nA = 14, nB = 10; const float phi = 0.6f;
        const float thetaA = phi + k * TAU_F / nA;              // tooth k of A on the contact line
        const float thetaB = meshAngle(thetaA, nA, nB, phi);
        float u = (phi + PI_F - thetaB) * nB / TAU_F;           // B tooth units at contact
        u -= std::floor(u);
        assert(std::fabs(u - 0.5f) < 1e-3f);
    }
    // Ratchet: whole steps land on whole teeth.
    assert(std::fabs(ratchetAngle(340 * 3, 340, 170, 12) - 3 * TAU_F / 12) < 1e-5f);

    // ── CardSteps: NfcWriter labels -> tracker ─────────────────────────────
    assert(CardSteps::issueStep("Writing NDEF...") == 0);
    assert(CardSteps::issueStep("Authenticating...") == 1);
    assert(CardSteps::issueStep("Configuring SDM...") == 2);
    for (const char* k : {"Writing key K1...", "Writing key K2...", "Writing key K3...",
                          "Writing key K4...", "Writing master key K0..."})
        assert(CardSteps::issueStep(k) == 2);
    assert(CardSteps::issueStep("Card written") == -1);
    assert(CardSteps::wipeStep("Authenticating...") == 1);
    assert(CardSteps::wipeStep("Disabling SDM...") == 2);
    for (const char* k : {"Resetting K1...", "Resetting K2...", "Resetting K3...", "Resetting K4...", "Resetting K0..."})
        assert(CardSteps::wipeStep(k) == 2);
    assert(CardSteps::wipeStep("Clearing NDEF...") == 3);
    assert(CardSteps::wipeStep("Card wiped") == -1);
    assert(CardSteps::issueStep(nullptr) == -1);
    assert(CardSteps::advance(2, 1) == 2 && CardSteps::advance(1, 3) == 3);

    // ── Scenes: band seams + dirty-rect contract ───────────────────────────
    MachineScene m;
    m.set("Confirming payment", "Settling over Lightning", Mood::Receive, 35);
    checkScene("machine/receive", m, 3000, 41);
    m.set("Sending payment", "Paying the tapped card", Mood::Send, 2100);
    checkScene("machine/send", m, 2000, 53);
    m.set("Confirming payment", "Reconnecting...", Mood::Stall, 35);
    checkScene("machine/stall", m, 3000, 97);
    m.set("Payment received", "Finishing up. Do not tap again.", Mood::Receive, 35, true);
    checkScene("machine/committed", m, 1500, 37);
    m.set("Creating invoice", "One moment", Mood::Work, 35, false, true);
    checkScene("machine/cancel", m, 1500, 61);

    // Cancel button where main.cpp hit-tests it (MotionUi::cancelHit).
    fullFrame(m, 0, g_ref);
    {
        Fb4 fb; fb.attach(g_full, sizeof(g_full)); m.palette(fb, 0);
        const uint16_t border = fb.pal[15], bg = fb.pal[0];
        CHECK(g_ref[MachineScene::CANCEL_Y][MachineScene::CANCEL_X + 20] == border, "cancel top border missing");
        CHECK(g_ref[MachineScene::CANCEL_Y - 2][MachineScene::CANCEL_X + 20] == bg, "cancel button taller than hit box");
    }

    CelebrateScene c;
    c.set(Celebration::Received, 35, "Payment received");
    checkScene("celebrate/received", c, c.duration(), 29);
    c.set(Celebration::Sent, 125000, "Payment sent");
    checkScene("celebrate/sent", c, c.duration(), 31);
    assert(c.chimeAt() > 0 && c.chimeAt() < c.duration());

    CardWorkScene w;
    w.set(CardOp::Issue);
    for (int st = 0; st < 3; ++st) { w.setStep(st); checkScene("cardwork/issue", w, 1200, 89); }
    w.set(CardOp::Wipe);
    for (int st = 0; st < 4; ++st) { w.setStep(st); checkScene("cardwork/wipe", w, 1200, 89); }

    CardDoneScene d;
    d.set(CardOp::Issue); checkScene("carddone/issue", d, d.duration(), 33);
    d.set(CardOp::Wipe);  checkScene("carddone/wipe", d, d.duration(), 33);

    ProvisionScene p;
    p.set("RIC-7F3A");
    checkScene("provision", p, 4000, 71);

    ConnectScene n;
    n.set(LinkPhase::Join, "Connecting to WiFi", "Bitcoin Cafe", true);
    checkScene("connect/join", n, 2500, 47);
    n.set(LinkPhase::Link, "Linking to openLN", "Secure connection", false);
    checkScene("connect/link", n, 2500, 47);
    n.set(LinkPhase::Retry, "Reconnecting to openLN", "Saved settings kept. Retrying.", false);
    checkScene("connect/retry", n, 2500, 47);
    // The WiFi Cancel button stays where handleConnectingWifi hit-tests it.
    n.set(LinkPhase::Join, "Connecting to WiFi", "Bitcoin Cafe", true);
    fullFrame(n, 0, g_ref);
    {
        Fb4 fb; fb.attach(g_full, sizeof(g_full)); n.palette(fb, 0);
        CHECK(g_ref[218][100] != fb.pal[0] && g_ref[218][88] == fb.pal[0] && g_ref[218][232] == fb.pal[0],
              "connect cancel button outside the (90..230, 202..234) hit box");
    }

    UpdateScene u;
    u.set(UpdatePhase::Checking, "Checking updates", "Secure connection to openLN");
    checkScene("update/checking", u, 2000, 59);
    u.set(UpdatePhase::Download, "Updating firmware", "v1.0.13 to v1.0.14", "Do not disconnect power");
    for (int pct : {0, 1, 37, 99, 100}) { u.setPercent(pct); checkScene("update/download", u, 600, 101); }
    u.set(UpdatePhase::Verified, "Update verified", "Restarting device");
    checkScene("update/verified", u, 1500, 43);
    u.set(UpdatePhase::Failed, "Update not installed", "download_stalled");
    checkScene("update/failed", u, 1500, 43);
    u.set(UpdatePhase::UpToDate, "Up to date", "Version 1.0.14");
    checkScene("update/uptodate", u, 1500, 43);

    if (failures) { std::printf("%d motion check(s) failed\n", failures); return 1; }
    std::printf("motion: all checks passed\n");
    return 0;
}
