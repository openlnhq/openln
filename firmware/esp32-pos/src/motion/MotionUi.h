#pragma once
// MotionUi: the firmware's animated screens, one call per screen moment.
// Each call configures its scene and hands it to the Motion task; the call
// returns immediately and the animation keeps running while the caller
// blocks on network or NFC I/O. Call MotionUi::stop() (or any normal screen
// draw, which does it for you) to take the screen back.
#include <TFT_eSPI.h>
#include "Scenes.h"

namespace MotionUi {

void begin(TFT_eSPI& tft);
void stop();

// ── Payments ──────────────────────────────────────────────────────────────
// Machine "crunching lightning". Re-calling with the machine already on
// screen keeps the gears turning (no restart), only the text/mood changes.
void processing(const char* title, const char* subtitle, Scenes::Mood mood,
                long sats = 0, bool cancelButton = false);
// Receive: invoice settling after the card tap / PIN.
void confirming(long sats, bool committed, bool stalled = false);
// Success celebration: magnet pull (received) or blast (sent), flood to green.
void celebrate(bool sent, long sats);
bool cancelHit(int tx, int ty);   // Cancel button drawn by processing(..., true)

// ── Cards ─────────────────────────────────────────────────────────────────
void cardWork(Scenes::CardOp op);
void cardStepLabel(const char* nfcWriterLabel);  // NfcWriter onStep label
void cardStep(int step);
void cardDone(Scenes::CardOp op);   // continues (no restart) if already playing
void cardFinish();                   // cardDone() for the op passed to cardWork()

// ── Device status ─────────────────────────────────────────────────────────
void provision(const char* deviceName);
void connect(Scenes::LinkPhase phase, const char* title, const char* detail, bool cancelButton);
void update(Scenes::UpdatePhase phase, const char* title, const char* detail, const char* footer = "");
void updatePercent(int percent);

// Milliseconds from now until the playing scene's sound cue (the success
// flash); 0 when there is none or it has passed. Lets loop() time the chime
// to the visual peak while the buzzer stays on the main task.
uint32_t chimeDelayMs();

} // namespace MotionUi
