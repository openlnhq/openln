#pragma once
// Pure motion math for the RIC animation engine: easing curves, colour
// mixing, deterministic noise, gear meshing and the amount count-up.
// No Arduino dependencies: compiled natively by tests/ric-motion.cpp and by
// the host preview renderer, so what the tests check is what the device runs.
#include <stdint.h>
#include <math.h>

namespace MotionMath {

static constexpr float PI_F  = 3.14159265358979f;
static constexpr float TAU_F = 6.28318530717959f;

inline float clamp01(float v) { return v < 0.f ? 0.f : (v > 1.f ? 1.f : v); }
inline float lerp(float a, float b, float t) { return a + (b - a) * t; }

// Normalised progress of `t` inside [start, start+dur], clamped to 0..1.
inline float phase(uint32_t t, uint32_t start, uint32_t dur) {
    if (t <= start) return 0.f;
    if (dur == 0 || t >= start + dur) return 1.f;
    return (float)(t - start) / (float)dur;
}

// ── Easing (all map 0->0 and 1->1) ─────────────────────────────────────────
inline float easeInCubic(float t)  { t = clamp01(t); return t * t * t; }
inline float easeOutCubic(float t) { t = clamp01(t); float u = 1.f - t; return 1.f - u * u * u; }
inline float easeInOutSine(float t){ t = clamp01(t); return 0.5f - 0.5f * cosf(PI_F * t); }
inline float easeOutQuad(float t)  { t = clamp01(t); return 1.f - (1.f - t) * (1.f - t); }
// Overshoots past 1 then settles: the mechanical "click" / badge pop.
inline float easeOutBack(float t, float s = 1.70158f) {
    t = clamp01(t); float u = t - 1.f;
    return 1.f + (s + 1.f) * u * u * u + s * u * u;
}

// ── Colour ──────────────────────────────────────────────────────────────────
inline uint16_t rgb565(uint8_t r, uint8_t g, uint8_t b) {
    return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}
// Mix two 24-bit colours (0xRRGGBB) and return RGB565.
inline uint16_t mix(uint32_t c0, uint32_t c1, float t) {
    t = clamp01(t);
    const int r0 = (c0 >> 16) & 0xFF, g0 = (c0 >> 8) & 0xFF, b0 = c0 & 0xFF;
    const int r1 = (c1 >> 16) & 0xFF, g1 = (c1 >> 8) & 0xFF, b1 = c1 & 0xFF;
    return rgb565((uint8_t)(r0 + (r1 - r0) * t + 0.5f),
                  (uint8_t)(g0 + (g1 - g0) * t + 0.5f),
                  (uint8_t)(b0 + (b1 - b0) * t + 0.5f));
}
inline uint16_t hex565(uint32_t c) { return rgb565((c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF); }

// ── Deterministic noise ─────────────────────────────────────────────────────
// Same inputs -> same output on every core and on the host, so a frame drawn
// by the background pump matches one drawn by the loop task.
inline uint32_t hash32(uint32_t x) {
    x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16;
    return x;
}
inline uint32_t hash2(uint32_t a, uint32_t b) { return hash32(a * 0x9E3779B1U ^ hash32(b)); }
// Uniform float in [0,1).
inline float noise01(uint32_t a, uint32_t b) { return (hash2(a, b) >> 8) * (1.0f / 16777216.0f); }
// Uniform float in [-1,1).
inline float noiseSigned(uint32_t a, uint32_t b) { return noise01(a, b) * 2.f - 1.f; }

// ── Gears ───────────────────────────────────────────────────────────────────
// Angle of gear B (nB teeth) meshing with gear A (nA teeth, angle thetaA),
// where phi is the direction from A's centre to B's centre. Tooth k of a
// gear with angle theta sits at theta + k*TAU/n. Rolling contact means B
// turns opposite to A at ratio nA/nB, and a tooth of A at the contact line
// faces a GAP of B (half a tooth pitch offset), so the teeth interlock.
inline float meshAngle(float thetaA, int nA, int nB, float phi) {
    const float uA = (thetaA - phi) * (float)nA / TAU_F;          // A tooth units at contact
    return phi + PI_F + (0.5f - uA) * TAU_F / (float)nB;
}

// Ratchet drive: the machine advances one tooth per `stepMs`, snapping each
// step with a small overshoot. Returns the accumulated angle for gear A.
inline float ratchetAngle(uint32_t t, uint32_t stepMs, uint32_t moveMs, int teeth) {
    if (stepMs == 0 || teeth <= 0) return 0.f;
    const uint32_t k = t / stepMs;
    const uint32_t in = t % stepMs;
    const float f = in >= moveMs ? 1.f : easeOutBack((float)in / (float)moveMs, 2.2f);
    return ((float)k + f) * TAU_F / (float)teeth;
}

// ── Amount count-up ─────────────────────────────────────────────────────────
// Value shown while counting 0 -> amount; never exceeds amount and lands on
// it exactly at p = 1 (a money screen must end on the true number).
inline long countUp(long amount, float p) {
    if (amount <= 0) return 0;
    if (p >= 1.f) return amount;
    const float e = easeOutCubic(p);
    long v = (long)((float)amount * e);
    if (v > amount) v = amount;
    if (v < 0) v = 0;
    return v;
}

// Thousands separators: 12345 -> "12,345". `out` must hold 16+ bytes.
inline void groupDigits(long value, char* out, int cap) {
    char tmp[24]; int n = 0;
    bool neg = value < 0; unsigned long v = neg ? (unsigned long)(-value) : (unsigned long)value;
    do { tmp[n++] = (char)('0' + (v % 10)); v /= 10; } while (v && n < 20);
    int o = 0;
    if (neg && o < cap - 1) out[o++] = '-';
    for (int i = n - 1; i >= 0 && o < cap - 1; --i) {
        out[o++] = tmp[i];
        if (i && i % 3 == 0 && o < cap - 1) out[o++] = ',';
    }
    out[o] = 0;
}

} // namespace MotionMath
