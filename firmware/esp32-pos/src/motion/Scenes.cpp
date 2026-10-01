// RIC motion scenes — see Scenes.h. Pure C++ (no Arduino), host-renderable.
#include "Scenes.h"
#include "../core/MotionMath.h"
#include <string.h>
#include <stdio.h>
#include <math.h>

using namespace MotionMath;

namespace Scenes {

static const Fb4Font* F2 = nullptr;   // TFT_eSPI Font 2 (16 px)
static const Fb4Font* F4 = nullptr;   // TFT_eSPI Font 4 (26 px)
static const Fb4Font* F6 = nullptr;   // TFT_eSPI Font 6 (48 px numerals)
void setFonts(const Fb4Font* small, const Fb4Font* med, const Fb4Font* big) { F2 = small; F4 = med; F6 = big; }

// ── Brand colours (24-bit) ──────────────────────────────────────────────────
static const uint32_t C_BG      = 0x0A0A0A;
static const uint32_t C_GRID    = 0x1C1C1C;
static const uint32_t C_BORDER  = 0x333333;
static const uint32_t C_MUTED   = 0x8C8C8C;
static const uint32_t C_WHITE   = 0xFFFFFF;
static const uint32_t C_OR      = 0xEA7C1E;   // brand orange
static const uint32_t C_OR_BR   = 0xF7A93C;
static const uint32_t C_OR_DK   = 0x9A520F;
static const uint32_t C_OR_DIM  = 0x4A2808;
static const uint32_t C_HOT     = 0xFFFBE8;   // white-hot electricity
static const uint32_t C_YEL     = 0xFFE36E;
static const uint32_t C_AMBER   = 0xFFAE2A;
static const uint32_t C_GREEN   = 0x22C55E;
static const uint32_t C_GREEN_BR= 0x9BF5BE;
static const uint32_t C_GREEN_DK= 0x052E16;
static const uint32_t C_FIELD   = 0x16A34A;   // success field (contrast for white text)
static const uint32_t C_FIELD_DK= 0x0B3D1E;
static const uint32_t C_RED     = 0xEF4444;

static inline void copyStr(char* dst, const char* src, size_t cap) {
    if (!src) src = "";
    strncpy(dst, src, cap - 1); dst[cap - 1] = 0;
}

// ── Shared glyphs ───────────────────────────────────────────────────────────

// ₿ drawn as vectors so it is bold at any size and can scale continuously
// (perspective as the magnet pulls coins in). h = cap height in pixels.
// Built only from additive strokes (no cut-outs), so it reads over any
// background: stem, three bars, two right-half ring bowls, and the two
// through-ticks above and below that make it a bitcoin sign, not a 'B'.
static void drawBtc(Fb4& fb, float h, float cx, float cy, uint8_t c) {
    if (h < 6.f) h = 6.f;
    const float sw = fmaxf(2.f, h * 0.17f);         // stroke
    const float w = h * 0.70f;                      // cap width
    const float x0 = cx - w * 0.5f, y0 = cy - h * 0.5f, y1 = y0 + h;
    const float ym = y0 + h * 0.47f;                // middle bar top
    const float ru = (ym + sw - y0) * 0.5f;         // upper bowl outer radius
    const float rl = (y1 - ym) * 0.5f;              // lower bowl outer radius
    const float xu = x0 + w * 0.90f - ru, xl = x0 + w - rl;
    fb.fillRectF(x0, y0, sw, h, c);                                   // stem
    fb.fillRectF(x0, y0, xu - x0 + 0.5f, sw, c);                     // top bar
    fb.fillRectF(x0, ym, fmaxf(xu, xl) - x0 + 0.5f, sw, c);          // middle bar
    fb.fillRectF(x0, y1 - sw, xl - x0 + 0.5f, sw, c);                // bottom bar
    fb.fillArc(xu, y0 + ru, ru - sw, ru, -PI_F * 0.5f, PI_F * 0.5f, c);
    fb.fillArc(xl, ym + rl, rl - sw, rl, -PI_F * 0.5f, PI_F * 0.5f, c);
    // Ticks snapped to whole pixels so both always have the same width.
    const int tw = (int)fmaxf(1.f, lroundf(sw * 0.62f)), ext = (int)fmaxf(2.f, lroundf(h * 0.17f));
    const int t1 = (int)lroundf(x0 + h * 0.13f), t2 = (int)lroundf(x0 + w * 0.52f);
    const int ya = (int)ceilf(y0 - 0.5f), yb = (int)ceilf(y1 - 0.5f);
    fb.fillRect(t1, ya - ext, tw, ext, c); fb.fillRect(t2, ya - ext, tw, ext, c);
    fb.fillRect(t1, yb, tw, ext, c);       fb.fillRect(t2, yb, tw, ext, c);
}

// Lightning bolt, height ~ s, as three convex pieces.
static void drawBolt(Fb4& fb, float cx, float cy, float s, uint8_t c) {
    auto X = [&](float v) { return cx + v * s; };
    auto Y = [&](float v) { return cy + v * s; };
    fb.fillQuad(X(0.05f), Y(-0.50f), X(0.40f), Y(-0.50f), X(0.13f), Y(-0.07f), X(-0.26f), Y(0.07f), c);
    fb.fillQuad(X(0.13f), Y(-0.07f), X(0.36f), Y(-0.07f), X(-0.02f), Y(0.07f), X(-0.26f), Y(0.07f), c);
    fb.fillTriangle(X(0.36f), Y(-0.07f), X(-0.20f), Y(0.56f), X(-0.02f), Y(0.07f), c);
}

// Check mark stroke, progressive (p in 0..1), matching the classic geometry.
static void drawCheck(Fb4& fb, float cx, float cy, float s, float p, float width, uint8_t c) {
    const float ax = cx - 16 * s, ay = cy, bx = cx - 4 * s, by = cy + 12 * s, ex = cx + 16 * s, ey = cy - 10 * s;
    const float l1 = sqrtf((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
    const float l2 = sqrtf((ex - bx) * (ex - bx) + (ey - by) * (ey - by));
    const float d = clamp01(p) * (l1 + l2);
    if (d <= 0.f) return;
    if (d <= l1) { const float k = d / l1; fb.thickLine(ax, ay, ax + (bx - ax) * k, ay + (by - ay) * k, width, c); return; }
    fb.thickLine(ax, ay, bx, by, width, c);
    const float k = (d - l1) / l2;
    fb.thickLine(bx, by, bx + (ex - bx) * k, by + (ey - by) * k, width, c);
}

// Jagged electric arc between two points: glow, body, white-hot core.
static void drawArcBolt(Fb4& fb, float ax, float ay, float bx, float by, uint32_t seed,
                        int segs, float amp, uint8_t glow, uint8_t mid, uint8_t hot,
                        float* outX = nullptr, float* outY = nullptr) {
    float xs[10], ys[10];
    if (segs > 9) segs = 9;
    const float dx = bx - ax, dy = by - ay;
    const float len = sqrtf(dx * dx + dy * dy) + 0.001f;
    const float nx = -dy / len, ny = dx / len;
    for (int i = 0; i <= segs; ++i) {
        const float u = (float)i / (float)segs;
        const float taper = sinf(u * PI_F);                 // pinned at both ends
        const float off = (i == 0 || i == segs) ? 0.f : noiseSigned(seed, (uint32_t)i) * amp * taper;
        xs[i] = ax + dx * u + nx * off; ys[i] = ay + dy * u + ny * off;
    }
    for (int i = 0; i < segs; ++i) fb.thickLine(xs[i], ys[i], xs[i + 1], ys[i + 1], 7.f, glow);
    for (int i = 0; i < segs; ++i) fb.thickLine(xs[i], ys[i], xs[i + 1], ys[i + 1], 3.6f, mid);
    for (int i = 0; i < segs; ++i) fb.thickLine(xs[i], ys[i], xs[i + 1], ys[i + 1], 1.6f, hot, false);
    if (outX && outY) for (int i = 0; i <= segs; ++i) { outX[i] = xs[i]; outY[i] = ys[i]; }
}

// A machined gear with fixed top-left lighting: teeth facing the light are
// highlighted, teeth facing away are shaded. Holes rotate with the gear.
struct GearInk { uint8_t light, main, dark, hole, hub; };
static void drawGear(Fb4& fb, float cx, float cy, int teeth, float rp, float theta,
                     const GearInk& ink, bool bigHub) {
    const float m = 2.f * rp / (float)teeth;
    const float rt = rp + m * 0.95f, rr = rp - m * 1.05f;
    const float pitch = TAU_F / (float)teeth;
    const float hwR = pitch * 0.30f, hwT = pitch * 0.17f;
    const float lightAng = -2.356f;   // light from the upper left
    // Silhouette pass in the hole colour: separates meshing gears that share
    // a palette so the contact reads as interlocking teeth, not one blob.
    for (int k = 0; k < teeth; ++k) {
        const float a = theta + k * pitch;
        const float r0 = rr - 1.5f, ro = rt + 1.6f, hwo = hwT + 0.06f, hwi = hwR + 0.05f;
        fb.fillQuad(cx + cosf(a - hwi) * r0, cy + sinf(a - hwi) * r0,
                    cx + cosf(a - hwo) * ro, cy + sinf(a - hwo) * ro,
                    cx + cosf(a + hwo) * ro, cy + sinf(a + hwo) * ro,
                    cx + cosf(a + hwi) * r0, cy + sinf(a + hwi) * r0, ink.hole);
    }
    fb.fillCircle(cx, cy, rr + 1.6f, ink.hole);
    for (int k = 0; k < teeth; ++k) {
        const float a = theta + k * pitch;
        const float lit = cosf(a - lightAng);
        const uint8_t c = lit > 0.45f ? ink.light : (lit < -0.45f ? ink.dark : ink.main);
        const float r0 = rr - 1.5f;
        fb.fillQuad(cx + cosf(a - hwR) * r0, cy + sinf(a - hwR) * r0,
                    cx + cosf(a - hwT) * rt, cy + sinf(a - hwT) * rt,
                    cx + cosf(a + hwT) * rt, cy + sinf(a + hwT) * rt,
                    cx + cosf(a + hwR) * r0, cy + sinf(a + hwR) * r0, c);
    }
    fb.fillCircle(cx + 1.2f, cy + 1.2f, rr, ink.dark);          // shadowed rim
    fb.fillCircle(cx - 0.6f, cy - 0.6f, rr - 0.6f, ink.main);   // face
    fb.fillRing(cx, cy, rr - 5.5f, rr - 3.8f, ink.dark);        // machined groove
    const float hubR = bigHub ? rr * 0.52f : rr * 0.30f;
    const int holes = teeth >= 12 ? 6 : (teeth >= 9 ? 5 : 4);
    const float hr = ((rr - 5.5f) - hubR) * 0.30f;
    const float hd = (hubR + (rr - 5.5f)) * 0.5f;
    if (hr >= 1.5f) for (int k = 0; k < holes; ++k) {
        const float a = theta * 1.0f + k * TAU_F / (float)holes + 0.3f;
        fb.fillCircle(cx + cosf(a) * hd, cy + sinf(a) * hd, hr, ink.hole);
    }
    fb.fillCircle(cx, cy, hubR, ink.dark);
    fb.fillCircle(cx, cy, hubR - 2.2f, ink.hub);
    if (!bigHub) { fb.fillCircle(cx, cy, 2.6f, ink.dark); fb.fillCircle(cx - 0.6f, cy - 0.6f, 1.2f, ink.light); }
}

// Hero amount: "125,000 sats" with the number in Font 6 (48 px) and the unit
// in Font 4 on the same baseline. Layout is computed from the FINAL amount and
// the number is right-anchored, so a count-up never jitters sideways. Font 6
// has no comma glyph, so commas are drawn. Falls back to Font 4 if too wide.
static void drawHeroAmount(Fb4& fb, long finalAmount, long shown, int cx, int top, uint8_t cNum, uint8_t cUnit) {
    char fin[20], cur[20];
    groupDigits(finalAmount, fin, sizeof(fin));
    groupDigits(shown, cur, sizeof(cur));
    auto numW = [](const char* s) {
        int w = 0;
        for (const char* p = s; *p; ++p) w += (*p == ',') ? 11 : Fb4::charWidth(*F6, (uint8_t)*p);
        return w;
    };
    const int unitW = Fb4::textWidth(*F4, "sats");
    const int gap = 9;
    const int fw = numW(fin);
    if (!F6 || fw + gap + unitW > 304) {
        char buf[32]; snprintf(buf, sizeof(buf), "%s sats", cur);
        fb.text(*F4, buf, cx, top + 14, FB_TC, cNum);
        return;
    }
    const int left = cx - (fw + gap + unitW) / 2;
    int x = left + fw - numW(cur);                     // right-anchored
    for (const char* p = cur; *p; ++p) {
        if (*p == ',') {                               // drawn comma
            fb.fillRect(x + 3, top + 31, 5, 5, cNum);
            fb.fillRect(x + 4, top + 36, 3, 2, cNum);
            fb.fillRect(x + 3, top + 38, 2, 2, cNum);
            x += 11;
        } else x += fb.glyph(*F6, (uint8_t)*p, x, top, cNum);
    }
    // Font 6 baseline is 36, Font 4 baseline 19: align the unit to it.
    fb.text(*F4, "sats", left + fw + gap, top + 36 - 19, FB_TL, cUnit);
}

// ═══════════════════════════════════════════════════════════════════════════
// MachineScene
// ═══════════════════════════════════════════════════════════════════════════
// Palette
enum : uint8_t { M_BG, M_GRID, M_MUTED, M_TEXT, M_G_DARK, M_G_MAIN, M_G_LIGHT, M_HUB,
                 M_BOLT, M_E_GLOW, M_E_MID, M_E_HOT, M_COIN, M_COIN_DIM, M_AMOUNT, M_TRACE };

// Gear train geometry (screen coordinates).
static const float GA_X = 128.f, GA_Y = 128.f, GA_R = 38.f;  static const int GA_N = 14;
static const float GB_PHI = -0.56f;                          static const int GB_N = 9;
static const float GC_PHI = 1.05f;                           static const int GC_N = 7;

void MachineScene::set(const char* title, const char* subtitle, Mood mood, long amount, bool committed,
                       bool cancel) {
    copyStr(_title, title, sizeof(_title));
    copyStr(_sub, subtitle, sizeof(_sub));
    _mood = mood; _amount = amount; _committed = committed; _cancel = cancel;
}

void MachineScene::timing(uint32_t& stepMs, uint32_t& moveMs) const {
    if (_mood == Mood::Stall) { stepMs = 1100; moveMs = 520; return; }
    if (_committed)           { stepMs = 230;  moveMs = 120; return; }
    stepMs = 340; moveMs = 170;
}

void MachineScene::palette(Fb4& fb, uint32_t t) {
    const bool stall = _mood == Mood::Stall;
    uint32_t stepMs, moveMs; timing(stepMs, moveMs);
    const uint32_t in = t % stepMs;
    const float impact = in >= moveMs ? 1.f - clamp01((float)(in - moveMs) / 160.f) : 0.f;
    const float breathe = 0.5f + 0.5f * sinf((float)t * TAU_F / (stall ? 1800.f : 760.f));
    fb.pal[M_BG] = hex565(C_BG);
    fb.pal[M_GRID] = hex565(0x181410);
    fb.pal[M_MUTED] = hex565(C_MUTED);
    fb.pal[M_TEXT] = hex565(C_WHITE);
    fb.pal[M_G_DARK]  = hex565(stall ? 0x4A3418 : C_OR_DK);
    fb.pal[M_G_MAIN]  = hex565(stall ? 0x7A5A34 : C_OR);
    fb.pal[M_G_LIGHT] = hex565(stall ? 0x9A7A50 : C_OR_BR);
    fb.pal[M_HUB] = hex565(0x1A1006);
    fb.pal[M_BOLT] = stall ? mix(0x3A2A10, C_AMBER, breathe * 0.6f)
                           : mix(C_AMBER, C_HOT, clamp01(breathe * 0.7f + impact));
    fb.pal[M_E_GLOW] = mix(0x2A1A06, 0x6A4210, impact);
    fb.pal[M_E_MID]  = hex565(C_AMBER);
    fb.pal[M_E_HOT]  = hex565(C_HOT);
    fb.pal[M_COIN] = hex565(C_OR_BR);
    fb.pal[M_COIN_DIM] = hex565(C_OR_DK);
    fb.pal[M_AMOUNT] = hex565(C_OR);
    fb.pal[M_TRACE] = hex565(0x333333);   // cancel button border
}

void MachineScene::render(Fb4& fb, uint32_t t) {
    // Static chrome (repainted only on the first frame; outside dirty()).
    fb.text(*F4, _title, 160, 26, FB_MC, M_TEXT);
    fb.text(*F2, _sub, 160, 51, FB_MC, M_MUTED);
    if (_cancel) {
        fb.roundRectOutline(CANCEL_X, CANCEL_Y, CANCEL_W, CANCEL_H, 6, 1, M_TRACE, M_BG);
        fb.text(*F2, "Cancel", CANCEL_X + CANCEL_W / 2, CANCEL_Y + CANCEL_H / 2, FB_MC, M_MUTED);
    } else if (_amount > 0) {
        char num[20], buf[32]; groupDigits(_amount, num, sizeof(num));
        snprintf(buf, sizeof(buf), "%s sats", num);
        fb.text(*F4, buf, 160, 212, FB_MC, M_AMOUNT);
    }

    // Blueprint dot grid.
    for (int y = 66; y < 188; y += 10)
        for (int x = 42; x < 280; x += 10) fb.px(x, y, M_GRID);

    const bool stall = _mood == Mood::Stall;
    const float dir = _mood == Mood::Send ? -1.f : 1.f;
    uint32_t stepMs, moveMs; timing(stepMs, moveMs);

    // Gear train: A drives, B and C are derived each frame so the teeth
    // always interlock exactly (no drift between pump and loop frames).
    const float thA = dir * ratchetAngle(t, stepMs, moveMs, GA_N);
    const float mA = 2.f * GA_R / (float)GA_N;
    const float rB = mA * GB_N / 2.f, rC = mA * GC_N / 2.f;
    const float bx = GA_X + cosf(GB_PHI) * (GA_R + rB), by = GA_Y + sinf(GB_PHI) * (GA_R + rB);
    const float cxg = bx + cosf(GC_PHI) * (rB + rC), cyg = by + sinf(GC_PHI) * (rB + rC);
    const float thB = meshAngle(thA, GA_N, GB_N, GB_PHI);
    const float thC = meshAngle(thB, GB_N, GC_N, GC_PHI);

    const GearInk ink{M_G_LIGHT, M_G_MAIN, M_G_DARK, M_BG, M_HUB};
    drawGear(fb, cxg, cyg, GC_N, rC, thC, ink, false);
    drawGear(fb, bx, by, GB_N, rB, thB, ink, false);
    drawGear(fb, GA_X, GA_Y, GA_N, GA_R, thA, ink, true);
    drawBolt(fb, GA_X + 1.f, GA_Y, 24.f, M_BOLT);

    if (stall) return;   // link down: the machine idles, no electricity

    // Feed lightning: raw electricity from a power node strikes the big gear,
    // re-struck every 70 ms. A pulse rides it inward (receive) or out (send).
    const uint32_t flick = t / 70;
    const uint32_t in = t % stepMs;
    const float impact = in >= moveMs ? 1.f - clamp01((float)(in - moveMs) / 160.f) : 0.f;
    const bool struck = noise01(flick, 7) < 0.8f || impact > 0.f;
    const float nx = 54.f, ny = 84.f;                      // power node
    const float sa = 3.62f;                                 // strike angle on gear A
    const float ex = GA_X + cosf(sa) * (GA_R - 1.f), ey = GA_Y + sinf(sa) * (GA_R - 1.f);
    const float nr = 3.2f + 1.6f * impact + 0.8f * noise01(flick, 9);
    fb.ditherCircle(nx, ny, nr + 7.f, M_E_GLOW);
    fb.fillCircle(nx, ny, nr + 2.5f, M_E_MID);
    fb.fillCircle(nx, ny, nr, M_E_HOT);
    if (struck) {
        float px[10], py[10];
        drawArcBolt(fb, nx, ny, ex, ey, flick * 31u + 5u, 6, 9.f, M_E_GLOW, M_E_MID, M_E_HOT, px, py);
        if (noise01(flick, 13) < 0.6f)
            drawArcBolt(fb, px[3], py[3], px[3] - 10.f + 20.f * noise01(flick, 14), py[3] + 20.f, flick * 17u + 3u, 3, 4.f,
                        M_E_GLOW, M_E_MID, M_E_HOT);
        fb.fillCircle(ex, ey, 3.5f + 2.5f * impact, M_E_MID);
        fb.fillCircle(ex, ey, 2.f + 1.5f * impact, M_E_HOT);
        float u = fmodf((float)t / 480.f, 1.f); if (dir < 0.f) u = 1.f - u;
        const float fi = u * 6.f; const int i0 = (int)fi; const float fr = fi - (float)i0;
        if (i0 < 6) {
            const float qx = px[i0] + (px[i0 + 1] - px[i0]) * fr, qy = py[i0] + (py[i0 + 1] - py[i0]) * fr;
            fb.fillCircle(qx, qy, 4.6f, M_E_MID);
            fb.fillCircle(qx, qy, 2.4f, M_E_HOT);
        }
    }

    // Crunch sparks where A and B mesh, fired on every ratchet impact.
    if (in >= moveMs) {
        const float age = (float)(in - moveMs);
        if (age < 210.f) {
            const float k = age / 210.f;
            const uint32_t step = t / stepMs;
            const float cpx = GA_X + cosf(GB_PHI) * GA_R, cpy = GA_Y + sinf(GB_PHI) * GA_R;
            const uint8_t col = k < 0.33f ? M_E_HOT : (k < 0.66f ? M_E_MID : M_E_GLOW);
            const int n = _committed ? 9 : 6;
            for (int s = 0; s < n; ++s) {
                const float side = (s & 1) ? 1.f : -1.f;
                const float a = GB_PHI + side * 1.571f + noiseSigned(step, (uint32_t)s) * 0.75f;
                const float len = 5.f + 16.f * easeOutCubic(k) * (0.6f + 0.4f * noise01(step, (uint32_t)s + 40u));
                const float r0 = len * 0.45f;
                fb.thickLine(cpx + cosf(a) * r0, cpy + sinf(a) * r0, cpx + cosf(a) * len, cpy + sinf(a) * len,
                             k < 0.5f ? 2.f : 1.2f, col, false);
            }
            if (k < 0.4f) fb.fillCircle(cpx, cpy, 4.5f * (1.f - k / 0.4f), M_E_HOT);
        }
    }

    // ₿ ejected from gear C on every crunch (receive) / fed into it (send).
    if (_mood == Mood::Receive || _mood == Mood::Send) {
        const float sx = cxg + cosf(-0.35f) * (rC + 7.f), sy = cyg + sinf(-0.35f) * (rC + 7.f);
        const uint32_t life = 700;
        const uint32_t first = t / stepMs;
        for (uint32_t j = 0; j < 4 && j <= first; ++j) {
            const uint32_t k = first - j;
            const uint32_t born = k * stepMs + moveMs;
            if (t < born) continue;
            const uint32_t age = t - born;
            if (age >= life) continue;
            float u = (float)age / (float)life;
            if (dir < 0.f) u = 1.f - u;
            const float qx = sx + 4.f + 40.f * easeOutQuad(u);
            const float qy = sy - 30.f * u + 34.f * u * u;
            const bool fresh = dir > 0.f ? (u < 0.6f) : (u > 0.4f);
            drawBtc(fb, 18.f - 6.f * (dir > 0.f ? u : 1.f - u), qx, qy, fresh ? M_COIN : M_COIN_DIM);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// CelebrateScene
// ═══════════════════════════════════════════════════════════════════════════
enum : uint8_t { P_BG, P_FIELD, P_COIN_FAR, P_COIN_MID, P_COIN_NEAR, P_TRAIL, P_CORE_GLOW, P_CORE_MID,
                 P_CORE_HOT, P_GREEN, P_EDGE, P_WHITE, P_GREEN_DK, P_TITLE, P_AMOUNT, P_BURST };

static const int   COINS = 18;
static const float CX = 160.f, CY = 118.f;
static const uint32_t T_FLASH = CelebrateScene::T_FLASH;

void CelebrateScene::set(Celebration kind, long amount, const char* title) {
    _kind = kind; _amount = amount; copyStr(_title, title, sizeof(_title));
}

void CelebrateScene::palette(Fb4& fb, uint32_t t) {
    t += T_FLASH - flashAt();                 // authored clock
    const float flash = t >= T_FLASH ? 1.f - phase(t, T_FLASH, 160) : 0.f;
    const float charge = phase(t, 690, 130);
    // The flash decays into deep green (not back to black), so the beat reads
    // black -> white pop -> green with no grey in between.
    fb.pal[P_BG] = t >= T_FLASH ? mix(C_FIELD_DK, C_WHITE, flash * flash)
                                : mix(C_BG, C_WHITE, charge * 0.12f);
    fb.pal[P_FIELD] = hex565(0x2E1A08);
    fb.pal[P_COIN_FAR] = hex565(C_OR);
    fb.pal[P_COIN_MID] = hex565(C_OR_BR);
    fb.pal[P_COIN_NEAR] = hex565(C_YEL);
    fb.pal[P_TRAIL] = hex565(C_OR_DIM);
    fb.pal[P_CORE_GLOW] = hex565(0x6A3408);
    fb.pal[P_CORE_MID] = hex565(C_AMBER);
    fb.pal[P_CORE_HOT] = mix(C_YEL, C_WHITE, 0.4f + 0.6f * charge);
    fb.pal[P_GREEN] = hex565(C_FIELD);
    fb.pal[P_EDGE] = hex565(C_GREEN_BR);
    fb.pal[P_WHITE] = hex565(C_WHITE);
    fb.pal[P_GREEN_DK] = hex565(C_GREEN);                // badge glow
    fb.pal[P_TITLE] = mix(C_FIELD, 0xDDF7E6, phase(t, 1180, 260));
    fb.pal[P_AMOUNT] = mix(C_FIELD, C_WHITE, phase(t, 1100, 200));
    fb.pal[P_BURST] = mix(C_WHITE, C_FIELD, phase(t, 900, 380));
}

void CelebrateScene::render(Fb4& fb, uint32_t t) {
    const bool sent = _kind == Celebration::Sent;
    const uint32_t tc = t;                    // real clock (coin flights)
    t += T_FLASH - flashAt();                 // authored clock (flash and after)
    const float R = t >= T_FLASH ? 210.f * easeOutCubic(phase(t, T_FLASH, 330)) : 0.f;

    if (R < 205.f) {
        // ── Phase 1: magnetic field + flying ₿ ─────────────────────────────
        if (t < T_FLASH) {
            for (int k = 0; k < 3; ++k) {
                float f = fmodf((float)t / 560.f + (float)k / 3.f, 1.f);
                const float r = sent ? 14.f + 190.f * f : 204.f * (1.f - f);
                if (r > 16.f) fb.fillRing(CX, CY, r - 1.f, r + 1.f, P_FIELD);
            }
        }
        int absorbed = 0;
        for (int i = 0; i < COINS; ++i) {
            const float a0 = (float)i * TAU_F / COINS + noiseSigned(11, (uint32_t)i) * 0.25f;
            const uint32_t delay = sent ? (uint32_t)((i * 7) % COINS) * 17u   // launch order hops around the ring
                                        : (hash2(3, (uint32_t)i) % 8u) * 38u;
            const uint32_t travel = sent ? 700u : 500u;
            const float p = phase(tc, delay, travel);
            if (p <= 0.f && sent) continue;
            auto pos = [&](float q, float& x, float& y, float& r) {
                const float e = sent ? easeOutQuad(q) : easeInCubic(q);
                r = sent ? 12.f + 228.f * e : 232.f * (1.f - e);
                const float a = a0 + (sent ? -0.9f : 0.9f) * e;
                x = CX + cosf(a) * r; y = CY + sinf(a) * r * 0.82f;
            };
            float x, y, r; pos(p, x, y, r);
            if (!sent && r < 13.f) { ++absorbed; continue; }
            if (sent && p >= 1.f) continue;
            for (int tr = 1; tr <= 3; ++tr) {
                float tx, ty, trr; pos(clamp01(p - 0.045f * tr), tx, ty, trr);
                fb.fillCircle(tx, ty, 2.6f - 0.5f * tr, P_TRAIL);
            }
            const uint8_t col = r > 120.f ? P_COIN_FAR : (r > 60.f ? P_COIN_MID : P_COIN_NEAR);
            drawBtc(fb, 11.f + 11.f * clamp01(r / 200.f), x, y, col);
        }
        // Magnet core: grows as it absorbs, contracts before the release.
        if (t < T_FLASH) {
            float cr;
            if (sent) cr = 13.f + 2.f * sinf((float)tc / 45.f) - 8.f * phase(tc, 0, 340);
            else      cr = 6.f + 0.45f * absorbed + 1.4f * sinf((float)t / 55.f);
            cr *= 1.f - 0.6f * phase(t, 690, 130);
            if (cr > 1.f) {
                fb.ditherCircle(CX, CY, cr + 11.f, P_CORE_GLOW);
                fb.fillCircle(CX, CY, cr + 5.f, P_CORE_GLOW);
                fb.fillCircle(CX, CY, cr + 2.5f, P_CORE_MID);
                fb.fillCircle(CX, CY, cr, P_CORE_HOT);
            }
        }
    }

    // ── Phase 2: the spike — white flash, green flood, shockwave ──────────
    if (t >= T_FLASH) {
        if (R >= 205.f) fb.fillRect(0, 0, 320, 240, P_GREEN);
        else {
            fb.fillCircle(CX, CY, R, P_GREEN);
            fb.fillRing(CX, CY, R, R + 7.f, P_EDGE);
        }
        const float s = phase(t, T_FLASH, 260);
        if (s < 1.f) {
            const float r2 = 30.f + 220.f * easeOutQuad(s);
            fb.fillRing(CX, CY, r2, r2 + 3.f * (1.f - s) + 1.f, P_EDGE);
        }
        // Burst of ₿ sparks flying out of the core.
        const float b = phase(t, T_FLASH, 480);
        if (!sent && b < 1.f) for (int i = 0; i < 14; ++i) {
            const float a = (float)i * TAU_F / 14.f + noiseSigned(21, (uint32_t)i) * 0.2f;
            const float d = 24.f + (150.f + 40.f * noise01(22, (uint32_t)i)) * easeOutCubic(b);
            drawBtc(fb, 10.f + 6.f * easeOutCubic(b), CX + cosf(a) * d, CY + sinf(a) * d * 0.82f, P_BURST);
        }
    }

    // ── Phase 3: badge pop + check stroke, hero amount count-up, title ─────
    const float BY = 74.f, BR = 29.f;
    const float bp = phase(t, 940, 300);
    if (bp > 0.f) {
        const float br = BR * easeOutBack(bp, 2.0f);
        const float gp = phase(t, 1000, 500);
        if (gp > 0.f) fb.ditherCircle(160.f, BY, br + 4.f + 8.f * easeOutCubic(gp), P_GREEN_DK);
        fb.fillCircle(160.f, BY, br, P_WHITE);
        drawCheck(fb, 160.f, BY + 1.f, 0.92f, phase(t, 1060, 260), 6.5f, P_GREEN);
    }
    const float ap = phase(t, 1100, 520);
    if (ap > 0.f && _amount > 0) {
        const int rise = (int)lroundf(8.f * (1.f - easeOutCubic(phase(t, 1100, 240))));
        // Received counts up (money arriving); sent shows the confirmed amount.
        drawHeroAmount(fb, _amount, sent ? _amount : countUp(_amount, ap), 160, 118 + rise, P_AMOUNT, P_AMOUNT);
    }
    const float tp = phase(t, 1180, 260);
    if (tp > 0.f) fb.text(*F4, _title, 160, 176 + (int)lroundf(8.f * (1.f - easeOutCubic(tp))), FB_TC, P_TITLE);
}

// ═══════════════════════════════════════════════════════════════════════════
// Cards (shared art)
// ═══════════════════════════════════════════════════════════════════════════
enum : uint8_t { K_BG, K_BODY, K_EDGE, K_CHIP, K_CHIP_LN, K_BOLT, K_LABEL, K_GLINT, K_OUTLINE,
                 K_GREEN, K_WHITE, K_MUTED, K_DUST, K_BEAM, K_RING, K_DIM };

struct CardBox { float cx, cy, w, h; };

// Shared geometry: the in-progress card and the finale card. The finale
// starts at WORK_CARD and springs to DONE_CARD, so the hand-off between the
// two scenes is one continuous move instead of a jump cut.
static const CardBox WORK_CARD{160.f, 116.f, 112.f, 70.f};
static const CardBox DONE_CARD{160.f, 92.f, 150.f, 94.f};

static inline CardBox lerpCard(const CardBox& a, const CardBox& b, float k) {
    return {lerp(a.cx, b.cx, k), lerp(a.cy, b.cy, k), lerp(a.w, b.w, k), lerp(a.h, b.h, k)};
}

static void cardRect(const CardBox& c, int& x, int& y, int& w, int& h, int& r) {
    x = (int)lroundf(c.cx - c.w / 2); y = (int)lroundf(c.cy - c.h / 2);
    w = (int)lroundf(c.w); h = (int)lroundf(c.h); r = (int)(c.h * 0.10f) + 2;
}

static void drawCardBody(Fb4& fb, const CardBox& c, uint8_t edge) {
    int x, y, w, h, r; cardRect(c, x, y, w, h, r);
    fb.roundRectOutline(x, y, w, h, r, 2, edge, K_BODY);
}

// Chip (+ optional waves, bolt, wordmark). ghost = blank card: chip outline only.
static void drawCardContents(Fb4& fb, const CardBox& c, bool ghost) {
    int x, y, w, h, r; cardRect(c, x, y, w, h, r);
    const float s = c.h / 94.f;
    const int chx = x + (int)(18 * s), chy = y + (int)(28 * s), chw = (int)(26 * s), chh = (int)(20 * s);
    if (ghost) {
        fb.roundRectOutline(chx, chy, chw, chh, (int)(4 * s) + 1, 1, K_DIM, K_BODY);
        return;
    }
    fb.fillRoundRect(chx, chy, chw, chh, (int)(4 * s) + 1, K_CHIP);
    fb.fillRect(chx, chy + chh / 2, chw, 1, K_CHIP_LN);
    fb.fillRect(chx + chw / 2, chy, 1, chh, K_CHIP_LN);
    fb.fillRect(chx + chw / 4, chy + chh / 4, chw / 2, chh / 2, K_CHIP_LN);
    fb.fillRect(chx + chw / 4 + 1, chy + chh / 4 + 1, chw / 2 - 2, chh / 2 - 2, K_CHIP);
    const float wx = x + 56 * s, wy = chy + chh / 2.f;          // contactless
    for (int i = 0; i < 3; ++i) {
        const float rr = (5.f + 5.f * i) * s;
        fb.fillArc(wx, wy, rr, rr + fmaxf(2.f, 2.2f * s), -0.8f, 0.8f, K_CHIP);
    }
    drawBolt(fb, x + w - 26 * s, y + 30 * s, 28 * s, K_BOLT);
    fb.text(*F2, "openLN", x + (int)(16 * s), y + h - (int)(14 * s) - 13, FB_TL, K_LABEL);
}

static void cardPalette(Fb4& fb) {
    fb.pal[K_BG] = hex565(C_BG);
    fb.pal[K_BODY] = hex565(0x1C1A18);
    fb.pal[K_EDGE] = hex565(C_OR);
    fb.pal[K_CHIP] = hex565(0xD9A84E);
    fb.pal[K_CHIP_LN] = hex565(0x7A5620);
    fb.pal[K_BOLT] = hex565(C_OR_BR);
    fb.pal[K_LABEL] = hex565(0xB0A89E);
    fb.pal[K_GLINT] = hex565(0xFFF4E0);
    fb.pal[K_OUTLINE] = hex565(0x4A4A4A);
    fb.pal[K_GREEN] = hex565(C_GREEN);
    fb.pal[K_WHITE] = hex565(C_WHITE);
    fb.pal[K_MUTED] = hex565(C_MUTED);
    fb.pal[K_DUST] = hex565(C_OR_BR);
    fb.pal[K_BEAM] = hex565(0xFF6A3A);
    fb.pal[K_RING] = hex565(C_GREEN_BR);
    fb.pal[K_DIM] = hex565(0x3A3632);
}

// Badge with a dark cut-out ring so it separates cleanly from the card edge.
static void drawCardBadge(Fb4& fb, float bx, float by, float r, float checkP) {
    fb.fillCircle(bx, by, r + 3.f, K_BG);
    fb.fillCircle(bx, by, r, K_GREEN);
    drawCheck(fb, bx, by + 1.f, r / 34.f, checkP, fmaxf(2.5f, r * 0.2f), K_GLINT);
}

// ═══════════════════════════════════════════════════════════════════════════
// CardDoneScene
// ═══════════════════════════════════════════════════════════════════════════
void CardDoneScene::set(CardOp op) { _op = op; }

void CardDoneScene::palette(Fb4& fb, uint32_t t) {
    cardPalette(fb);
    const uint32_t o = beat();
    fb.pal[K_WHITE] = mix(C_BG, C_WHITE, phase(t, 900 + o, 260));   // title fade
    fb.pal[K_MUTED] = mix(C_BG, C_MUTED, phase(t, 980 + o, 260));
    fb.pal[K_RING]  = mix(C_GREEN_BR, C_BG, phase(t, 860 + o, 420));
    if (_op == CardOp::Wipe) fb.pal[K_EDGE] = mix(C_OR, 0x4A4A4A, phase(t, 420, 560));
}

void CardDoneScene::render(Fb4& fb, uint32_t t) {
    const bool issue = _op == CardOp::Issue;
    const float mv = phase(t, 0, 420);
    const CardBox c = lerpCard(WORK_CARD, DONE_CARD, issue ? easeOutBack(mv, 1.4f) : easeOutCubic(mv));
    int x, y, w, h, r; cardRect(c, x, y, w, h, r);

    if (issue) {
        drawCardBody(fb, c, K_EDGE);
        drawCardContents(fb, c, false);
        // Glint sweep, masked inside the rounded corners.
        const float g = phase(t, 430, 380);
        if (g > 0.f && g < 1.f) {
            fb.setClip(x + r, y + 3, w - 2 * r, h - 6);
            const float gx = c.cx - c.w / 2 - 50.f + (c.w + 100.f) * easeInOutSine(g);
            const float yb = c.cy + c.h / 2, yt = c.cy - c.h / 2;
            fb.fillQuad(gx - 10, yb, gx + 8, yb, gx + 38, yt, gx + 20, yt, K_GLINT);
            fb.fillQuad(gx + 14, yb, gx + 18, yb, gx + 48, yt, gx + 44, yt, K_GLINT);
            fb.noClip();
        }
    } else {
        // A scan beam erases the card left to right; data dust flies off it.
        const float s = phase(t, 420, 560);
        const float left = c.cx - c.w / 2, right = c.cx + c.w / 2;
        const float beam = left + (right - left) * easeInOutSine(s);
        drawCardBody(fb, c, K_OUTLINE);
        drawCardContents(fb, c, true);
        if (s < 1.f) {
            fb.setClip((int)beam, 0, 320, 240);
            drawCardBody(fb, c, K_EDGE);
            drawCardContents(fb, c, false);
            fb.noClip();
        }
        if (s > 0.f && s < 1.f) {
            const int top = (int)(c.cy - c.h / 2) - 8, hh = (int)c.h + 16;
            fb.ditherRect((int)beam - 6, top + 4, 13, hh - 8, K_BEAM);
            fb.fillRect((int)beam - 1, top, 3, hh, K_BEAM);
            fb.fillRect((int)beam, top + 2, 1, hh - 4, K_GLINT);
        }
        for (int i = 0; i < 40; ++i) {
            const float ux = (float)i / 40.f;
            const uint32_t born = 420u + (uint32_t)(560.f * ux);
            if (t < born) continue;
            const float age = (float)(t - born) / 560.f; if (age >= 1.f) continue;
            const float ox = left + (right - left) * ux;
            const float oy = c.cy - c.h / 2 + 8.f + (c.h - 16.f) * noise01(31, (uint32_t)i);
            const float qx = ox + 30.f * easeOutCubic(age) * (0.4f + noise01(32, (uint32_t)i));
            const float qy = oy - 34.f * easeOutCubic(age) * noise01(33, (uint32_t)i);
            const int sz = age < 0.45f ? 3 : 2;
            fb.fillRect((int)qx, (int)qy, sz, sz, age < 0.45f ? K_DUST : K_OUTLINE);
        }
    }

    // Badge on the empty bottom-right corner: ring pulse, pop, check stroke.
    const float bx = c.cx + c.w / 2 - 10.f, by = c.cy + c.h / 2 - 10.f;
    const uint32_t o = beat();
    const float bp = phase(t, 820 + o, 260);
    if (bp > 0.f) {
        const float rp = phase(t, 860 + o, 420);
        if (rp < 1.f) { const float rr = 18.f + 11.f * easeOutCubic(rp); fb.fillRing(bx, by, rr, rr + 2.f, K_RING); }
        drawCardBadge(fb, bx, by, 17.f * easeOutBack(bp, 1.4f), phase(t, 880 + o, 220));
    }
    fb.text(*F4, issue ? "Card issued" : "Card wiped", 160, 172, FB_MC, K_WHITE);
    fb.text(*F2, issue ? "Ready for payments" : "Blank and ready to issue again", 160, 202, FB_MC, K_MUTED);
}

// ═══════════════════════════════════════════════════════════════════════════
// CardWorkScene
// ═══════════════════════════════════════════════════════════════════════════
void CardWorkScene::set(CardOp op) { _op = op; _step = 0; }

void CardWorkScene::palette(Fb4& fb, uint32_t t) {
    cardPalette(fb);
    const float pulse = 0.5f + 0.5f * sinf((float)t * TAU_F / 700.f);
    fb.pal[K_RING] = mix(C_OR, C_YEL, pulse);        // current step
    fb.pal[K_BEAM] = hex565(_op == CardOp::Issue ? C_AMBER : 0xFF6A3A);
}

void CardWorkScene::render(Fb4& fb, uint32_t t) {
    const bool issue = _op == CardOp::Issue;
    fb.text(*F4, issue ? "Writing card" : "Wiping card", 160, 26, FB_MC, K_WHITE);
    fb.text(*F2, "Keep the card on the reader", 160, 51, FB_MC, K_MUTED);

    const CardBox c = WORK_CARD;
    int x, y, w, h, r; cardRect(c, x, y, w, h, r);
    drawCardBody(fb, c, K_EDGE);
    // Scanner sweeps inside the card body, under the art.
    const float u = 0.5f - 0.5f * cosf((float)t * TAU_F / 1300.f);
    const int by = y + 6 + (int)((h - 14) * u);
    fb.ditherRect(x + 4, by - 3, w - 8, 8, K_BEAM);
    fb.fillRect(x + 4, by, w - 8, 2, K_BEAM);
    drawCardContents(fb, c, false);

    // Data packets in three lanes per side: inbound (write) / outbound (wipe).
    for (int side = -1; side <= 1; side += 2) {
        for (int lane = 0; lane < 3; ++lane) {
            for (int k = 0; k < 2; ++k) {
                float f = fmodf((float)t / 760.f + 0.5f * k + 0.17f * lane, 1.f);
                if (!issue) f = 1.f - f;                     // f = 1 at the card edge
                const float d = 10.f + 52.f * (1.f - f);
                const float px = side < 0 ? (float)x - d - 4.f : (float)(x + w) + d;
                const float py = c.cy - 12.f + 12.f * lane;
                fb.fillRect((int)px, (int)py - 1, 5, 3, f > 0.45f ? K_DUST : K_DIM);
            }
        }
    }

    // Step tracker.
    const int n = steps();
    static const char* WRITE[3] = {"Write data", "Authenticate", "Secure card"};
    static const char* WIPE[4]  = {"Read", "Authenticate", "Reset", "Erase"};
    const char* const* lbl = issue ? WRITE : WIPE;
    const float span = issue ? 104.f : 80.f;
    const float x0 = 160.f - span * (n - 1) / 2.f;
    const int cur = _step;
    for (int i = 0; i < n - 1; ++i) {
        const float xa = x0 + span * i + 10.f, xb = x0 + span * (i + 1) - 10.f;
        fb.fillRect((int)xa, 183, (int)(xb - xa), 2, i < cur ? K_GREEN : K_DIM);
    }
    for (int i = 0; i < n; ++i) {
        const float sx = x0 + span * i;
        if (i < cur) {
            fb.fillCircle(sx, 184.f, 8.f, K_GREEN);
            drawCheck(fb, sx, 185.f, 0.27f, 1.f, 2.4f, K_GLINT);
        } else if (i == cur) {
            fb.fillRing(sx, 184.f, 5.5f, 8.5f, K_RING);
            fb.fillCircle(sx, 184.f, 2.5f, K_RING);
        } else {
            fb.fillRing(sx, 184.f, 6.f, 8.f, K_DIM);
        }
        fb.text(*F2, lbl[i], (int)sx, 204, FB_TC, i <= cur ? K_WHITE : K_MUTED);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// ProvisionScene
// ═══════════════════════════════════════════════════════════════════════════
enum : uint8_t { V_BG, V_TEXT, V_MUTED, V_NAME, V_RING0, V_RING1, V_RING2, V_RING3,
                 V_CORE, V_CORE_EDGE, V_RUNE, V_ORBIT, V_GLOW };

void ProvisionScene::set(const char* name) { copyStr(_name, name, sizeof(_name)); }

void ProvisionScene::palette(Fb4& fb, uint32_t t) {
    const float b = 0.5f + 0.5f * sinf((float)t * TAU_F / 1600.f);
    fb.pal[V_BG] = hex565(C_BG);
    fb.pal[V_TEXT] = hex565(C_WHITE);
    fb.pal[V_MUTED] = hex565(C_MUTED);
    fb.pal[V_NAME] = hex565(C_OR);
    fb.pal[V_RING0] = hex565(C_OR_BR);
    fb.pal[V_RING1] = hex565(C_OR);
    fb.pal[V_RING2] = hex565(C_OR_DK);
    fb.pal[V_RING3] = hex565(0x3A2008);
    fb.pal[V_CORE] = mix(0x2A1606, 0x4A2808, b);
    fb.pal[V_CORE_EDGE] = mix(C_OR, C_OR_BR, b);
    fb.pal[V_RUNE] = hex565(C_WHITE);
    fb.pal[V_ORBIT] = hex565(C_YEL);
    fb.pal[V_GLOW] = hex565(0x24140A);
}

void ProvisionScene::render(Fb4& fb, uint32_t t) {
    const float cx = 160.f, cy = 88.f;
    // Beacon waves: emitted at a fixed rate, eased outward, fading to nothing.
    for (int k = 0; k < 3; ++k) {
        const float f = fmodf((float)t / 2400.f + (float)k / 3.f, 1.f);
        if (f > 0.92f) continue;
        const float r = 28.f + 34.f * easeOutQuad(f);
        const uint8_t col = f < 0.22f ? V_RING0 : (f < 0.45f ? V_RING1 : (f < 0.7f ? V_RING2 : V_RING3));
        fb.fillRing(cx, cy, r - 1.2f, r + 1.2f, col);
    }
    fb.fillRing(cx, cy, 24.f, 27.f, V_GLOW);
    fb.fillCircle(cx, cy, 24.f, V_CORE_EDGE);
    fb.fillCircle(cx, cy, 21.5f, V_CORE);
    // Bluetooth rune: stem + two chevrons + two ticks crossing at the stem.
    const float s = 0.95f, wd = 2.6f;
    fb.thickLine(cx - 1.f, cy - 13 * s, cx - 1.f, cy + 13 * s, wd, V_RUNE);
    fb.thickLine(cx - 1.f, cy - 13 * s, cx + 7 * s, cy - 6.5f * s, wd, V_RUNE);
    fb.thickLine(cx + 7 * s, cy - 6.5f * s, cx - 8 * s, cy + 6.5f * s, wd, V_RUNE);
    fb.thickLine(cx - 1.f, cy + 13 * s, cx + 7 * s, cy + 6.5f * s, wd, V_RUNE);
    fb.thickLine(cx + 7 * s, cy + 6.5f * s, cx - 8 * s, cy - 6.5f * s, wd, V_RUNE);

    fb.text(*F4, _name, 160, 162, FB_TC, V_NAME);
    fb.text(*F2, "Open openln.com/app, Link device,", 160, 194, FB_TC, V_MUTED);
    fb.text(*F2, "and choose this name", 160, 211, FB_TC, V_MUTED);
}

// ═══════════════════════════════════════════════════════════════════════════
// ConnectScene
// ═══════════════════════════════════════════════════════════════════════════
enum : uint8_t { N_BG, N_TEXT, N_MUTED, N_ARC_OFF, N_ARC_1, N_ARC_2, N_ARC_3, N_ARC_ON,
                 N_DOT, N_ORBIT, N_ORBIT_DIM, N_BTN, N_BTN_TEXT, N_WARN };

void ConnectScene::set(LinkPhase phase, const char* title, const char* detail, bool cancel) {
    _phase = phase; copyStr(_title, title, sizeof(_title)); copyStr(_detail, detail, sizeof(_detail)); _cancel = cancel;
}

void ConnectScene::palette(Fb4& fb, uint32_t t) {
    fb.pal[N_BG] = hex565(C_BG);
    fb.pal[N_TEXT] = hex565(C_WHITE);
    fb.pal[N_MUTED] = hex565(C_MUTED);
    fb.pal[N_ARC_OFF] = hex565(0x2A2420);
    fb.pal[N_ARC_1] = hex565(0x5A3410);
    fb.pal[N_ARC_2] = hex565(C_OR_DK);
    fb.pal[N_ARC_3] = hex565(C_OR);
    fb.pal[N_ARC_ON] = hex565(C_OR_BR);
    fb.pal[N_DOT] = hex565(C_OR_BR);
    fb.pal[N_ORBIT] = hex565(C_YEL);
    fb.pal[N_ORBIT_DIM] = hex565(C_OR_DK);
    fb.pal[N_BTN] = hex565(0xB42828);
    fb.pal[N_BTN_TEXT] = hex565(C_WHITE);
    const float slow = 0.5f + 0.5f * sinf((float)t * TAU_F / 1800.f);
    fb.pal[N_WARN] = mix(0x3A2A10, C_AMBER, slow);
}

void ConnectScene::render(Fb4& fb, uint32_t t) {
    const float px = 160.f, py = 118.f;           // arcs pivot (the dot)
    const float a0 = -2.36f, a1 = -0.785f;         // 45..135 degrees above
    const float radii[3] = {15.f, 29.f, 43.f};
    const float slow = 0.5f + 0.5f * sinf((float)t * TAU_F / 1800.f);
    for (int i = 0; i < 3; ++i) {
        uint8_t col;
        if (_phase == LinkPhase::Join) {
            // A signal wave rolls outward from the dot; never all dark.
            const float v = 0.5f + 0.5f * sinf(TAU_F * ((float)t / 1250.f - 0.22f * i));
            col = v > 0.85f ? N_ARC_ON : (v > 0.6f ? N_ARC_3 : (v > 0.32f ? N_ARC_2 : N_ARC_1));
        } else if (_phase == LinkPhase::Link) {
            col = N_ARC_ON;
        } else {
            // Weak signal: fills from the dot outward, pulsing amber.
            col = i == 0 ? N_WARN : (i == 1 && slow > 0.55f ? N_WARN : N_ARC_OFF);
        }
        fb.fillArc(px, py, radii[i] - 4.f, radii[i] + 3.5f, a0, a1, col);
    }
    fb.fillCircle(px, py, 5.5f, _phase == LinkPhase::Retry ? N_WARN : N_DOT);

    if (_phase == LinkPhase::Link) {
        // Handshake: packets on a flattened orbit around the signal.
        const float ox = 160.f, oy = 92.f, rx = 52.f, ry = 32.f;
        for (int p = 0; p < 3; ++p) {
            for (int k = 0; k < 4; ++k) {
                const float a = (float)t / 260.f + p * TAU_F / 3.f - 0.12f * k;
                fb.fillCircle(ox + cosf(a) * rx, oy + sinf(a) * ry, 3.f - 0.5f * k, k == 0 ? N_ORBIT : N_ORBIT_DIM);
            }
        }
    }

    fb.text(*F4, _title, 160, 160, FB_MC, N_TEXT);
    fb.text(*F2, _detail, 160, 186, FB_MC, N_MUTED);
    if (_cancel) {
        fb.fillRoundRect(90, 202, 140, 32, 6, N_BTN);
        fb.text(*F2, "Cancel", 160, 218, FB_MC, N_BTN_TEXT);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// UpdateScene
// ═══════════════════════════════════════════════════════════════════════════
enum : uint8_t { U_BG, U_TEXT, U_MUTED, U_TRACK, U_ARC, U_HEAD, U_GLOW, U_TICK, U_TICK_HI,
                 U_OK, U_BAD, U_WARN, U_INNER };

void UpdateScene::set(UpdatePhase phase, const char* title, const char* detail, const char* footer) {
    _phase = phase; copyStr(_title, title, sizeof(_title)); copyStr(_detail, detail, sizeof(_detail));
    copyStr(_footer, footer, sizeof(_footer));
}

void UpdateScene::palette(Fb4& fb, uint32_t t) {
    fb.pal[U_BG] = hex565(C_BG);
    fb.pal[U_TEXT] = hex565(C_WHITE);
    fb.pal[U_MUTED] = hex565(C_MUTED);
    fb.pal[U_TRACK] = hex565(0x241E18);
    fb.pal[U_ARC] = hex565(C_OR);
    fb.pal[U_HEAD] = hex565(C_HOT);
    fb.pal[U_GLOW] = hex565(C_OR_BR);
    fb.pal[U_TICK] = hex565(0x2E2620);
    fb.pal[U_TICK_HI] = hex565(0xC86A16);
    fb.pal[U_OK] = hex565(C_GREEN);
    fb.pal[U_BAD] = hex565(C_RED);
    // Steady amber: the footer sits outside dirty(), and a calm warning reads
    // as more serious than a blinking one while the download owns the CPU.
    fb.pal[U_WARN] = hex565(C_AMBER);
    fb.pal[U_INNER] = hex565(0x141210);
    (void)t;
}

void UpdateScene::render(Fb4& fb, uint32_t t) {
    const float cx = 160.f, cy = 128.f, ro = 50.f, ri = 41.f, rm = (ri + ro) * 0.5f, cap = (ro - ri) * 0.5f;
    fb.text(*F4, _title, 160, 28, FB_MC, U_TEXT);
    fb.text(*F2, _detail, 160, 54, FB_MC, U_MUTED);
    if (_footer[0]) {
        const int w = Fb4::textWidth(*F2, _footer), bw = 10, gap = 6;
        const int left = 160 - (bw + gap + w) / 2;
        drawBolt(fb, (float)left + bw * 0.5f, 213.f, 14.f, U_WARN);
        fb.text(*F2, _footer, left + bw + gap, 212, FB_ML, U_WARN);
    }

    const float top = -PI_F / 2.f;
    // Tick ring: fills with progress (download) or trails the spinner.
    float hiFrom = 0.f, hiTo = -1.f;
    if (_phase == UpdatePhase::Download) { hiFrom = top; hiTo = top + TAU_F * (float)_percent / 100.f; }
    if (_phase == UpdatePhase::Checking) { hiFrom = (float)t / 300.f - 0.6f; hiTo = (float)t / 300.f + 1.3f; }
    for (int k = 0; k < 36; ++k) {
        float a = (float)k * TAU_F / 36.f + top;
        if (hiTo > hiFrom) while (a < hiFrom) a += TAU_F;
        const bool hi = hiTo > hiFrom && a <= hiTo;
        fb.thickLine(cx + cosf(a) * 55.f, cy + sinf(a) * 55.f, cx + cosf(a) * 60.f, cy + sinf(a) * 60.f,
                     2.f, hi ? U_TICK_HI : U_TICK, false);
    }

    fb.fillRing(cx, cy, ri, ro, U_TRACK);
    fb.fillCircle(cx, cy, ri - 1.f, U_INNER);
    auto capAt = [&](float a, float r, uint8_t c) { fb.fillCircle(cx + cosf(a) * rm, cy + sinf(a) * rm, r, c); };
    char buf[16];
    switch (_phase) {
        case UpdatePhase::Checking: {
            const float a = (float)t / 300.f;
            fb.fillArc(cx, cy, ri, ro, a, a + 1.3f, U_ARC);
            capAt(a, cap, U_ARC);
            capAt(a + 1.3f, cap + 1.5f, U_GLOW);
            capAt(a + 1.3f, cap - 1.5f, U_HEAD);
            break;
        }
        case UpdatePhase::Download: {
            const float p = (float)_percent / 100.f;
            if (p > 0.f) {
                const float end = top + TAU_F * p;
                fb.fillArc(cx, cy, ri, ro, top, end, U_ARC);
                capAt(top, cap, U_ARC);
                const float pulse = 1.f + 0.8f * sinf((float)t / 90.f);
                capAt(end, cap + 1.f + pulse, U_GLOW);
                capAt(end, cap - 1.5f, U_HEAD);
            }
            snprintf(buf, sizeof(buf), "%d%%", (int)_percent);
            fb.text(*F4, buf, 160, (int)cy + 3, FB_MC, U_TEXT);   // optical centre
            break;
        }
        case UpdatePhase::Verified:
        case UpdatePhase::UpToDate: {
            fb.fillRing(cx, cy, ri, ro, U_OK);
            drawCheck(fb, cx, cy + 1.f, 1.1f, MotionMath::phase(t, 120, 320), 7.f, U_OK);
            break;
        }
        case UpdatePhase::Failed: {
            fb.fillRing(cx, cy, ri, ro, U_BAD);
            fb.thickLine(cx - 12, cy - 12, cx + 12, cy + 12, 6.f, U_BAD);
            fb.thickLine(cx + 12, cy - 12, cx - 12, cy + 12, 6.f, U_BAD);
            break;
        }
        case UpdatePhase::Info: {
            const float a = (float)t / 700.f;
            fb.fillArc(cx, cy, ri, ro, a, a + 0.9f, U_TICK_HI);
            capAt(a, cap, U_TICK_HI); capAt(a + 0.9f, cap, U_TICK_HI);
            drawBolt(fb, cx + 1.f, cy, 34.f, U_ARC);
            break;
        }
    }
}

} // namespace Scenes
