#pragma once
#include <cstdint>

// Device lifetime counters + boot diagnostics, reported in RIC telemetry.
// The pure parts are header-only (no Arduino deps) so the native test suite
// (tests/ric-device-stats.cpp) can compile them with plain g++.

namespace DeviceStats {

// esp_reset_reason_t values (esp_system.h, stable across ESP-IDF 4.x/5.x).
// Names are a contract with the server telemetry schema: [a-zA-Z0-9_-]{1,32}.
inline const char* resetReasonName(int code) {
    switch (code) {
        case 1:  return "poweron";   // power-on / EN-pin reset — unplug or power cut
        case 2:  return "ext";       // external reset pin (not on ESP32; kept for completeness)
        case 3:  return "sw";        // deliberate ESP.restart() (provisioning, factory reset, OTA)
        case 4:  return "panic";     // crash — Guru Meditation / abort
        case 5:  return "intwdt";    // interrupt watchdog
        case 6:  return "taskwdt";   // task watchdog — loop() stalled past its budget
        case 7:  return "wdt";       // other watchdog
        case 8:  return "deepsleep";
        case 9:  return "brownout";  // supply dipped below threshold — the classic CYD reboot cause
        case 10: return "sdio";      // reset over SDIO (unused on CYD)
        default: return "unknown";
    }
}

// Counters are implemented in DeviceStats.cpp (NVS-backed, "bitpos" namespace).
void begin();              // load persisted counters, count this boot, persist
void wifiDropped();        // one link-loss episode — call on the connected→down edge
void flushIfDirty();       // persist pending changes (called just before telemetry posts)
uint32_t bootCount();      // boots since flash / factory reset
uint32_t wifiDrops();      // link-loss episodes since boot
uint32_t wifiDropsTotal(); // link-loss episodes since flash / factory reset

} // namespace DeviceStats
