#pragma once
// RIC motion scenes. Each scene is a pure function of time: palette(t) sets
// the 16-colour palette, render(t) draws the whole 320x240 screen in screen
// coordinates (the Fb4 window clips it to the current band). No Arduino
// dependencies: the host preview tool renders exactly this code.
#include <stdint.h>
#include "Fb4.h"

namespace Scenes {

struct Rect { int x, y, w, h; };

// Fonts come from the platform (device: TFT_eSPI's flash tables).
// small = Font 2 (16 px), med = Font 4 (26 px), big = Font 6 (48 px numerals).
void setFonts(const Fb4Font* small, const Fb4Font* med, const Fb4Font* big);

class Scene {
public:
    virtual ~Scene() {}
    virtual void palette(Fb4& fb, uint32_t t) = 0;
    virtual void render(Fb4& fb, uint32_t t) = 0;
    // Region that can change after the first frame (the rest is static).
    virtual Rect dirty(uint32_t t) const { (void)t; return {0, 0, 320, 240}; }
    // 0 = runs until replaced; otherwise the final frame is t == duration().
    virtual uint32_t duration() const { return 0; }
    virtual uint8_t background() const { return 0; }
    // ms into the scene where the success chime belongs (0 = none).
    virtual uint32_t chimeAt() const { return 0; }
    virtual uint16_t frameMs() const { return 33; }
};

// ── Processing family: the "lightning crunching" machine ───────────────────
enum class Mood : uint8_t { Receive, Send, Work, Stall };

class MachineScene : public Scene {
public:
    void set(const char* title, const char* subtitle, Mood mood, long amountSats = 0,
             bool committed = false, bool cancelButton = false);
    Mood mood() const { return _mood; }
    // Cancel button geometry (touch hit-test must match the drawn button).
    static constexpr int CANCEL_X = 90, CANCEL_Y = 200, CANCEL_W = 140, CANCEL_H = 32;
    void palette(Fb4& fb, uint32_t t) override;
    void render(Fb4& fb, uint32_t t) override;
    Rect dirty(uint32_t) const override { return {36, 62, 248, 128}; }
private:
    char _title[40] = {0};
    char _sub[48] = {0};
    Mood _mood = Mood::Work;
    long _amount = 0;
    bool _committed = false;
    bool _cancel = false;
    void timing(uint32_t& stepMs, uint32_t& moveMs) const;
};

// ── Money moved: magnet-in (received) / blast-out (sent), green flood ──────
enum class Celebration : uint8_t { Received, Sent };

class CelebrateScene : public Scene {
public:
    void set(Celebration kind, long amountSats, const char* title);
    void palette(Fb4& fb, uint32_t t) override;
    void render(Fb4& fb, uint32_t t) override;
    // Timeline is authored around T_FLASH; Sent flashes earlier (its blast
    // clears the screen sooner) and everything after the flash shifts with it.
    static constexpr uint32_t T_FLASH = 820;
    uint32_t flashAt() const { return _kind == Celebration::Sent ? 560u : T_FLASH; }
    uint32_t duration() const override { return 1750 - (T_FLASH - flashAt()); }
    uint32_t chimeAt() const override { return flashAt(); }
private:
    Celebration _kind = Celebration::Received;
    long _amount = 0;
    char _title[32] = {0};
};

// ── Card written / wiped (finale) ───────────────────────────────────────────
enum class CardOp : uint8_t { Issue, Wipe };

class CardDoneScene : public Scene {
public:
    void set(CardOp op);
    CardOp op() const { return _op; }
    void palette(Fb4& fb, uint32_t t) override;
    void render(Fb4& fb, uint32_t t) override;
    // The wipe finale waits for the erase beam to exit before the badge pops.
    uint32_t beat() const { return _op == CardOp::Wipe ? 260u : 0u; }
    uint32_t duration() const override { return 1600 + beat(); }
    uint32_t chimeAt() const override { return 860 + beat(); }
private:
    CardOp _op = CardOp::Issue;
};

// ── Card write / wipe in progress (step tracker) ────────────────────────────
class CardWorkScene : public Scene {
public:
    void set(CardOp op);
    void setStep(int step) { _step = step; }      // safe from the I/O task
    int steps() const { return _op == CardOp::Issue ? 3 : 4; }
    void palette(Fb4& fb, uint32_t t) override;
    void render(Fb4& fb, uint32_t t) override;
    Rect dirty(uint32_t) const override { return {0, 66, 320, 160}; }
private:
    CardOp _op = CardOp::Issue;
    volatile int _step = 0;
};

// ── BLE provisioning: radar beacon ─────────────────────────────────────────
class ProvisionScene : public Scene {
public:
    void set(const char* deviceName);
    void palette(Fb4& fb, uint32_t t) override;
    void render(Fb4& fb, uint32_t t) override;
    Rect dirty(uint32_t) const override { return {92, 22, 136, 134}; }
private:
    char _name[24] = {0};
};

// ── Network: WiFi join / server link / retry ────────────────────────────────
enum class LinkPhase : uint8_t { Join, Link, Retry };

class ConnectScene : public Scene {
public:
    void set(LinkPhase phase, const char* title, const char* detail, bool cancelButton);
    LinkPhase phase() const { return _phase; }
    void palette(Fb4& fb, uint32_t t) override;
    void render(Fb4& fb, uint32_t t) override;
    Rect dirty(uint32_t) const override { return {104, 34, 112, 112}; }
private:
    LinkPhase _phase = LinkPhase::Join;
    char _title[40] = {0};
    char _detail[48] = {0};
    bool _cancel = false;
};

// ── Firmware update ─────────────────────────────────────────────────────────
enum class UpdatePhase : uint8_t { Checking, Download, Verified, UpToDate, Failed, Info };

class UpdateScene : public Scene {
public:
    void set(UpdatePhase phase, const char* title, const char* detail, const char* footer = "");
    void setPercent(int p) { _percent = p < 0 ? 0 : (p > 100 ? 100 : p); }
    UpdatePhase phase() const { return _phase; }
    void palette(Fb4& fb, uint32_t t) override;
    void render(Fb4& fb, uint32_t t) override;
    Rect dirty(uint32_t) const override { return {96, 64, 128, 128}; }
    uint16_t frameMs() const override { return 50; }   // shares the CPU with the download
private:
    UpdatePhase _phase = UpdatePhase::Info;
    volatile int _percent = 0;
    char _title[40] = {0};
    char _detail[48] = {0};
    char _footer[40] = {0};
};

} // namespace Scenes
