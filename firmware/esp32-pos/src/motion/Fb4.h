#pragma once
// Fb4: a 4-bit (16 colour palette) framebuffer window used by the RIC motion
// engine. Scenes draw in SCREEN coordinates; the window (x0,y0,w,h) clips.
// A full 320x240 frame is produced by rendering the same scene into several
// horizontal bands through one small static buffer, so the animations never
// allocate heap (TLS needs it) and never fragment it.
//
// Pure C++: no Arduino or TFT_eSPI dependency. The same code renders on the
// device and in the host preview tool, so previews are pixel-faithful.
// Fonts use TFT_eSPI's own data formats (Font 2 bitmap, Font 4 RLE), passed
// in as tables so the device reuses the font data already in flash.
#include <stdint.h>
#include <string.h>
#include <math.h>

struct Fb4Font {
    const uint8_t*        widths;   // 96 entries, chars 32..127
    const uint8_t* const* glyphs;   // 96 glyph pointers
    uint8_t               height;   // cell height (px)
    uint8_t               baseline;
    bool                  rle;      // false: 1-bit rows (Font 2); true: RLE (Font 4)
};

enum Fb4Datum : uint8_t { FB_TL, FB_TC, FB_TR, FB_ML, FB_MC, FB_MR, FB_BL, FB_BC, FB_BR };

class Fb4 {
public:
    uint16_t pal[16] = {0};   // RGB565 palette (native order)
    int x0 = 0, y0 = 0, w = 0, h = 0, stride = 0;

    void attach(uint8_t* mem, uint32_t capBytes) { _mem = mem; _cap = capBytes; }
    uint32_t capacity() const { return _cap; }
    const uint8_t* data() const { return _mem; }

    // Largest band height that fits `width` columns in the buffer.
    int bandRows(int width) const { int s = (width + 1) / 2; return s ? (int)(_cap / (uint32_t)s) : 0; }

    bool setWindow(int x, int y, int ww, int hh) {
        if (ww <= 0 || hh <= 0) return false;
        int s = (ww + 1) / 2;
        if ((uint32_t)s * (uint32_t)hh > _cap) return false;
        x0 = x; y0 = y; w = ww; h = hh; stride = s;
        return true;
    }

    void clear(uint8_t c) { c &= 15; memset(_mem, (c << 4) | c, (size_t)stride * (size_t)h); }

    // Optional clip rectangle (screen coords), intersected with the window.
    void setClip(int x, int y, int ww, int hh) { _cx0 = x; _cy0 = y; _cx1 = x + ww - 1; _cy1 = y + hh - 1; }
    void noClip() { _cx0 = -32768; _cy0 = -32768; _cx1 = 32767; _cy1 = 32767; }

    inline void px(int x, int y, uint8_t c) {
        if (x < _cx0 || x > _cx1 || y < _cy0 || y > _cy1) return;
        x -= x0; y -= y0;
        if ((unsigned)x >= (unsigned)w || (unsigned)y >= (unsigned)h) return;
        uint8_t* p = _mem + y * stride + (x >> 1);
        if (x & 1) *p = (uint8_t)((*p & 0xF0) | (c & 15));
        else       *p = (uint8_t)((*p & 0x0F) | ((c & 15) << 4));
    }
    inline uint8_t get(int x, int y) const {
        x -= x0; y -= y0;
        if ((unsigned)x >= (unsigned)w || (unsigned)y >= (unsigned)h) return 0;
        const uint8_t b = _mem[y * stride + (x >> 1)];
        return (x & 1) ? (b & 15) : (b >> 4);
    }

    // Horizontal span, inclusive screen columns xa..xb.
    void span(int xa, int xb, int y, uint8_t c) {
        if (y < _cy0 || y > _cy1) return;
        if (xa < _cx0) xa = _cx0;
        if (xb > _cx1) xb = _cx1;
        y -= y0; if ((unsigned)y >= (unsigned)h) return;
        xa -= x0; xb -= x0;
        if (xa < 0) xa = 0;
        if (xb >= w) xb = w - 1;
        if (xa > xb) return;
        c &= 15;
        uint8_t* row = _mem + y * stride;
        if (xa & 1) { row[xa >> 1] = (uint8_t)((row[xa >> 1] & 0xF0) | c); xa++; }
        if (xa > xb) return;
        if (!(xb & 1)) { row[xb >> 1] = (uint8_t)((row[xb >> 1] & 0x0F) | (c << 4)); xb--; }
        if (xa > xb) return;
        memset(row + (xa >> 1), (c << 4) | c, (size_t)((xb - xa + 1) >> 1));
    }

    void fillRect(int x, int y, int ww, int hh, uint8_t c) {
        int ya = y < y0 ? y0 : y, yb = (y + hh - 1) > (y0 + h - 1) ? (y0 + h - 1) : (y + hh - 1);
        for (int yy = ya; yy <= yb; ++yy) span(x, x + ww - 1, yy, c);
    }
    // Sub-pixel rect: fills pixels whose centres lie inside [x,x+w)x[y,y+h).
    void fillRectF(float x, float y, float ww, float hh, uint8_t c) {
        const int xa = (int)ceilf(x - 0.5f), xb = (int)ceilf(x + ww - 0.5f) - 1;
        const int ya = (int)ceilf(y - 0.5f), yb = (int)ceilf(y + hh - 0.5f) - 1;
        if (xb < xa || yb < ya) return;
        fillRect(xa, ya, xb - xa + 1, yb - ya + 1, c);
    }

    // Row-range helper: rows whose centres fall inside [ya, yb] AND the window.
    inline void rows(float ya, float yb, int& r0, int& r1) const {
        r0 = (int)ceilf(ya - 0.5f); r1 = (int)floorf(yb - 0.5f);
        if (r0 < y0) r0 = y0;
        if (r1 > y0 + h - 1) r1 = y0 + h - 1;
    }

    void fillCircle(float cx, float cy, float r, uint8_t c) {
        if (r <= 0.f) return;
        int r0, r1; rows(cy - r, cy + r, r0, r1);
        const float rr = r * r;
        for (int y = r0; y <= r1; ++y) {
            const float dy = (float)y + 0.5f - cy;
            const float d2 = rr - dy * dy; if (d2 < 0.f) continue;
            const float dx = sqrtf(d2);
            span((int)ceilf(cx - dx - 0.5f), (int)floorf(cx + dx - 0.5f), y, c);
        }
    }

    // Annulus between radii ri (inner) and ro (outer).
    void fillRing(float cx, float cy, float ri, float ro, uint8_t c) {
        if (ro <= 0.f || ro <= ri) return;
        if (ri <= 0.f) { fillCircle(cx, cy, ro, c); return; }
        int r0, r1; rows(cy - ro, cy + ro, r0, r1);
        for (int y = r0; y <= r1; ++y) {
            const float dy = (float)y + 0.5f - cy;
            const float o2 = ro * ro - dy * dy; if (o2 < 0.f) continue;
            const float ox = sqrtf(o2);
            const int xa = (int)ceilf(cx - ox - 0.5f), xb = (int)floorf(cx + ox - 0.5f);
            const float i2 = ri * ri - dy * dy;
            if (i2 <= 0.f) { span(xa, xb, y, c); continue; }
            const float ix = sqrtf(i2);
            span(xa, (int)ceilf(cx - ix - 0.5f) - 1, y, c);
            span((int)floorf(cx + ix - 0.5f) + 1, xb, y, c);
        }
    }

    // Annulus sector from angle a0 to a1 (radians, screen convention:
    // 0 = +x, increasing clockwise because screen y points down). Sector
    // membership uses cross products (no atan2 per pixel).
    void fillArc(float cx, float cy, float ri, float ro, float a0, float a1, uint8_t c) {
        const float TAU = 6.28318530718f;
        if (a1 <= a0) return;
        if (a1 - a0 >= TAU) { fillRing(cx, cy, ri, ro, c); return; }
        const float sx = cosf(a0), sy = sinf(a0), ex = cosf(a1), ey = sinf(a1);
        const bool wide = (a1 - a0) > 3.14159265f;
        int r0, r1; rows(cy - ro, cy + ro, r0, r1);
        for (int y = r0; y <= r1; ++y) {
            const float dy = (float)y + 0.5f - cy;
            const float o2 = ro * ro - dy * dy; if (o2 < 0.f) continue;
            const float ox = sqrtf(o2);
            const int xa = (int)ceilf(cx - ox - 0.5f), xb = (int)floorf(cx + ox - 0.5f);
            const float i2 = ri * ri - dy * dy;
            const float ix = i2 > 0.f ? sqrtf(i2) : -1.f;
            int runStart = 0; bool inRun = false;
            for (int x = xa; x <= xb + 1; ++x) {
                bool in = false;
                if (x <= xb) {
                    const float dx = (float)x + 0.5f - cx;
                    if (!(ix >= 0.f && fabsf(dx) < ix)) {
                        const float c1 = sx * dy - sy * dx;   // cross(start, p)
                        const float c2 = dx * ey - dy * ex;   // cross(p, end)
                        in = wide ? !(c1 < 0.f && c2 < 0.f) : (c1 >= 0.f && c2 >= 0.f);
                    }
                }
                if (in && !inRun) { inRun = true; runStart = x; }
                else if (!in && inRun) { inRun = false; span(runStart, x - 1, y, c); }
            }
        }
    }

    // Convex polygon (n <= 8), pixel-centre sampling.
    void fillConvex(const float* xs, const float* ys, int n, uint8_t c) {
        if (n < 3) return;
        float ymin = ys[0], ymax = ys[0];
        for (int i = 1; i < n; ++i) { if (ys[i] < ymin) ymin = ys[i]; if (ys[i] > ymax) ymax = ys[i]; }
        int r0, r1; rows(ymin, ymax, r0, r1);
        for (int y = r0; y <= r1; ++y) {
            const float yc = (float)y + 0.5f;
            float xl = 1e9f, xr = -1e9f;
            for (int i = 0; i < n; ++i) {
                const int j = (i + 1) % n;
                const float ya = ys[i], yb = ys[j];
                if ((yc < ya && yc < yb) || (yc > ya && yc > yb) || ya == yb) continue;
                const float x = xs[i] + (yc - ya) * (xs[j] - xs[i]) / (yb - ya);
                if (x < xl) xl = x;
                if (x > xr) xr = x;
            }
            if (xl <= xr) span((int)ceilf(xl - 0.5f), (int)floorf(xr - 0.5f), y, c);
        }
    }
    void fillTriangle(float ax, float ay, float bx, float by, float cx, float cy, uint8_t c) {
        const float xs[3] = {ax, bx, cx}, ys[3] = {ay, by, cy};
        fillConvex(xs, ys, 3, c);
    }
    void fillQuad(float ax, float ay, float bx, float by, float cx, float cy, float dx, float dy, uint8_t c) {
        const float xs[4] = {ax, bx, cx, dx}, ys[4] = {ay, by, cy, dy};
        fillConvex(xs, ys, 4, c);
    }

    // Thick segment with optional round caps.
    void thickLine(float ax, float ay, float bx, float by, float width, uint8_t c, bool caps = true) {
        const float dx = bx - ax, dy = by - ay;
        const float len = sqrtf(dx * dx + dy * dy);
        const float hw = width * 0.5f;
        if (len < 0.01f) { fillCircle(ax, ay, hw, c); return; }
        const float nx = -dy / len * hw, ny = dx / len * hw;
        fillQuad(ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny, c);
        if (caps && width >= 2.5f) { fillCircle(ax, ay, hw, c); fillCircle(bx, by, hw, c); }
    }

    void line(int ax, int ay, int bx, int by, uint8_t c) {
        int dx = bx > ax ? bx - ax : ax - bx, sx = ax < bx ? 1 : -1;
        int dy = by > ay ? ay - by : by - ay, sy = ay < by ? 1 : -1;
        int err = dx + dy;
        for (;;) {
            px(ax, ay, c);
            if (ax == bx && ay == by) break;
            const int e2 = 2 * err;
            if (e2 >= dy) { err += dy; ax += sx; }
            if (e2 <= dx) { err += dx; ay += sy; }
        }
    }

    void fillRoundRect(int x, int y, int ww, int hh, int r, uint8_t c) {
        if (r * 2 > ww) r = ww / 2;
        if (r * 2 > hh) r = hh / 2;
        int ya = y < y0 ? y0 : y, yb = y + hh - 1; if (yb > y0 + h - 1) yb = y0 + h - 1;
        for (int yy = ya; yy <= yb; ++yy) {
            int inset = 0;
            const int top = yy - y, bot = (y + hh - 1) - yy;
            const int d = top < r ? r - top : (bot < r ? r - bot : 0);
            if (d > 0) {
                const float fy = (float)d - 0.5f;
                inset = (int)(r - sqrtf((float)(r * r) - fy * fy) + 0.5f);
            }
            span(x + inset, x + ww - 1 - inset, yy, c);
        }
    }
    void roundRectOutline(int x, int y, int ww, int hh, int r, int t, uint8_t outer, uint8_t inner) {
        fillRoundRect(x, y, ww, hh, r, outer);
        fillRoundRect(x + t, y + t, ww - 2 * t, hh - 2 * t, r > t ? r - t : 0, inner);
    }

    // 50% checkerboard fill: a cheap translucent glow on a 16-colour buffer.
    void ditherCircle(float cx, float cy, float r, uint8_t c) {
        if (r <= 0.f) return;
        int r0, r1; rows(cy - r, cy + r, r0, r1);
        for (int y = r0; y <= r1; ++y) {
            const float dy = (float)y + 0.5f - cy;
            const float d2 = r * r - dy * dy; if (d2 < 0.f) continue;
            const float dx = sqrtf(d2);
            int xa = (int)ceilf(cx - dx - 0.5f), xb = (int)floorf(cx + dx - 0.5f);
            for (int x = xa + (((xa + y) & 1)); x <= xb; x += 2) px(x, y, c);
        }
    }

    // 50% checkerboard rect (a cheap "glow" in a 16-colour palette).
    void ditherRect(int x, int y, int ww, int hh, uint8_t c) {
        for (int yy = y; yy < y + hh; ++yy)
            for (int xx = x + ((x + yy) & 1); xx < x + ww; xx += 2) px(xx, yy, c);
    }

    // ── Text (TFT_eSPI Font 2 / Font 4 data) ────────────────────────────────
    static int charWidth(const Fb4Font& f, char ch) {
        unsigned u = (unsigned char)ch; if (u < 32 || u > 127) u = 32;
        return f.widths[u - 32];
    }
    static int textWidth(const Fb4Font& f, const char* s) {
        int wsum = 0; while (s && *s) wsum += charWidth(f, *s++); return wsum;
    }
    int text(const Fb4Font& f, const char* s, int x, int y, Fb4Datum d, uint8_t c) {
        const int tw = textWidth(f, s), th = f.height;
        switch (d) {
            case FB_TC: x -= tw / 2; break;
            case FB_TR: x -= tw; break;
            case FB_ML: y -= th / 2; break;
            case FB_MC: x -= tw / 2; y -= th / 2; break;
            case FB_MR: x -= tw; y -= th / 2; break;
            case FB_BL: y -= th; break;
            case FB_BC: x -= tw / 2; y -= th; break;
            case FB_BR: x -= tw; y -= th; break;
            default: break;
        }
        // Skip the whole string when it cannot touch this band.
        if (y >= y0 + h || y + th <= y0) return tw;
        while (s && *s) { x += glyph(f, *s++, x, y, c); }
        return tw;
    }
    int glyph(const Fb4Font& f, char ch, int x, int y, uint8_t c) {
        unsigned u = (unsigned char)ch; if (u < 32 || u > 127) u = 32;
        const int gw = f.widths[u - 32];
        const uint8_t* g = f.glyphs[u - 32];
        if (!g || x >= x0 + w || x + gw <= x0) return gw;
        if (!f.rle) {
            const int bpr = (gw + 6) / 8;
            for (int r = 0; r < f.height; ++r) {
                const int yy = y + r; if (yy < y0 || yy >= y0 + h) continue;
                for (int k = 0; k < bpr; ++k) {
                    const uint8_t bits = g[r * bpr + k]; if (!bits) continue;
                    for (int b = 0; b < 8; ++b) if (bits & (0x80 >> b)) px(x + k * 8 + b, yy, c);
                }
            }
        } else {
            const int total = gw * f.height;
            int pc = 0;
            while (pc < total) {
                uint8_t v = *g++;
                const bool on = v & 0x80; int run = (v & 0x7F) + 1;
                if (on) {
                    while (run-- && pc < total) {   // never spill past the glyph box
                        const int gx = pc % gw, gy = pc / gw;
                        px(x + gx, y + gy, c);
                        ++pc;
                    }
                } else pc += run;
            }
        }
        return gw;
    }

private:
    uint8_t* _mem = nullptr;
    uint32_t _cap = 0;
    int _cx0 = -32768, _cy0 = -32768, _cx1 = 32767, _cy1 = 32767;
};
