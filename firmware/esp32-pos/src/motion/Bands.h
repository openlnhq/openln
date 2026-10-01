#pragma once
// Banded rendering: produce any screen rectangle of a scene through the one
// small Fb4 buffer, band by band. Shared by the device engine (Motion.cpp)
// and the host preview, so both paint exactly the same pixels.
#include "Fb4.h"
#include "Scenes.h"

namespace Bands {

// Band buffer capacity shared by device and preview (4-bit pixels: 8 KB holds
// 51 full-width rows, so a full-screen frame is 5 bands).
constexpr uint32_t kBandBytes = 8192;

// Clamp a rect to the 320x240 screen; returns false when empty.
inline bool clampRect(Scenes::Rect& r) {
    if (r.x < 0) { r.w += r.x; r.x = 0; }
    if (r.y < 0) { r.h += r.y; r.y = 0; }
    if (r.x + r.w > 320) r.w = 320 - r.x;
    if (r.y + r.h > 240) r.h = 240 - r.y;
    return r.w > 0 && r.h > 0;
}

// Render `r` of scene `s` at time t. present(fb) is called once per band with
// the window (fb.x0, fb.y0, fb.w, fb.h) filled and fb.pal set for this frame.
template <typename Present>
inline void render(Fb4& fb, Scenes::Scene& s, uint32_t t, Scenes::Rect r, Present present) {
    if (!clampRect(r)) return;
    s.palette(fb, t);
    const int rows = fb.bandRows(r.w);
    if (rows <= 0) return;
    for (int y = r.y; y < r.y + r.h; y += rows) {
        const int hh = (r.y + r.h - y) < rows ? (r.y + r.h - y) : rows;
        fb.setWindow(r.x, y, r.w, hh);
        fb.noClip();
        fb.clear(s.background());
        s.render(fb, t);
        fb.noClip();
        present(fb);
    }
}

} // namespace Bands
