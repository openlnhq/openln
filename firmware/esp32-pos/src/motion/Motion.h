#pragma once
// Motion engine (device side): a small render task that owns the TFT while a
// scene plays, so animation stays smooth while the main loop blocks on HTTPS,
// TLS handshakes, PN532 I/O or the OTA download.
//
// Screen-ownership contract (the only rule callers must follow):
//   * While a scene is playing, nothing else draws to the TFT.
//   * Before drawing anything yourself, call Motion::stop(). It waits for the
//     frame in flight (at most one frame) and hands the screen back.
//   * Every full-screen draw in the firmware begins with Motion::stop() (see
//     the fillScreen sites), so ordinary screens are safe by construction.
//
// Memory: band buffer, line buffer and task stack are all static. Nothing is
// taken from the heap, so TLS headroom is unaffected by fragmentation.
#include <Arduino.h>
#include <TFT_eSPI.h>
#include "Scenes.h"

namespace Motion {

void begin(TFT_eSPI& tft);

// Hold off rendering while a scene's parameters are mutated. Keep it short.
void lock();
void unlock();

// Call with the lock held: make `s` the playing scene. If it is already the
// playing scene and keepClock is true, the clock keeps running (no jump in
// the animation) and the next frame repaints the full screen.
void showLocked(Scenes::Scene* s, bool keepClock);

// Stop animating and hand the screen back to the caller. Safe to call when
// idle (cheap) and from any task except the motion task itself.
void stop();

Scenes::Scene* current();       // playing (or finished-and-holding) scene
uint32_t elapsedMs();           // since the current scene started

// RAII helper: Motion::Locked l; ... mutate scene ...; l.show(&scene);
struct Locked {
    Locked() { lock(); }
    ~Locked() { unlock(); }
    void show(Scenes::Scene* s, bool keepClock) { showLocked(s, keepClock); }
};

} // namespace Motion
