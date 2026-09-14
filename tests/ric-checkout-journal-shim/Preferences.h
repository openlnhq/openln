#pragma once
#include "nvs.h"
// Match Arduino Preferences: putBytes/remove commit, end only closes.
class Preferences {
public:
    ~Preferences() { end(); }
    bool begin(const char* name, bool readOnly = false) {
        if (started_) return false;
        started_ = nvs_open(name, readOnly ? NVS_READONLY : NVS_READWRITE, &handle_) == ESP_OK;
        return started_;
    }
    void end() { if (started_) nvs_close(handle_); started_ = false; }
    size_t putBytes(const char* key, const void* data, size_t len) {
        if (!started_ || nvs_set_blob(handle_, key, data, len) != ESP_OK ||
            nvs_commit(handle_) != ESP_OK) return 0;
        return len;
    }
    bool remove(const char* key) {
        return started_ && nvs_erase_key(handle_, key) == ESP_OK && nvs_commit(handle_) == ESP_OK;
    }
private:
    nvs_handle_t handle_ = 0;
    bool started_ = false;
};
