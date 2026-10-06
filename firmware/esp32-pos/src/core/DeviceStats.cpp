#include "DeviceStats.h"
#include <Arduino.h>
#include <nvs.h>
#include <nvs_flash.h>

// Persistence shares Config's "bitpos" NVS namespace on purpose: a factory
// reset (Config::clear → nvs_erase_all) and a fresh flash both start a new
// history, which is exactly what we want these counters to represent.
namespace {
constexpr const char* KEY_BOOTS = "statBoots";   // survives reboots
constexpr const char* KEY_DROPS = "statDrops";   // survives reboots
constexpr uint32_t SAVE_MIN_INTERVAL_MS = 30000; // rate-limit flash writes while flapping

uint32_t s_boots = 0;
uint32_t s_dropsTotal = 0;
uint32_t s_drops = 0;        // since boot (volatile)
uint32_t s_lastSaveMs = 0;
bool s_dirty = false;

void save() {
    nvs_handle_t h;
    if (nvs_open("bitpos", NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_u32(h, KEY_BOOTS, s_boots);
    nvs_set_u32(h, KEY_DROPS, s_dropsTotal);
    nvs_commit(h);
    nvs_close(h);
    s_dirty = false;
    s_lastSaveMs = millis();
}
} // namespace

void DeviceStats::begin() {
    nvs_handle_t h;
    if (nvs_open("bitpos", NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u32(h, KEY_BOOTS, &s_boots);       // missing key leaves the value untouched
        nvs_get_u32(h, KEY_DROPS, &s_dropsTotal);
        nvs_close(h);
    }
    s_boots += 1;   // count this boot
    s_drops = 0;
    save();         // persist right away — a reboot loop must still count boots
    Serial.printf("RIC stats: boot #%u reset=%d dropsTotal=%u\n",
                  s_boots, (int)esp_reset_reason(), s_dropsTotal);
}

void DeviceStats::wifiDropped() {
    s_drops += 1;
    s_dropsTotal += 1;
    s_dirty = true;
    if (millis() - s_lastSaveMs >= SAVE_MIN_INTERVAL_MS) save();
}

void DeviceStats::flushIfDirty() {
    if (s_dirty) save();
}

uint32_t DeviceStats::bootCount()      { return s_boots; }
uint32_t DeviceStats::wifiDrops()      { return s_drops; }
uint32_t DeviceStats::wifiDropsTotal() { return s_dropsTotal; }
