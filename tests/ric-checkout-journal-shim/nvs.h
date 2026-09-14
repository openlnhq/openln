#pragma once
// Host-only NVS fault model. Durable bytes survive reboot; open handles do not.
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <map>
#include <string>
#include <vector>
using esp_err_t = int;
using nvs_handle_t = uint32_t;
enum nvs_open_mode_t { NVS_READONLY, NVS_READWRITE };
constexpr esp_err_t ESP_OK = 0;
constexpr esp_err_t ESP_FAIL = -1;
constexpr esp_err_t ESP_ERR_NVS_NOT_FOUND = 0x1102;
constexpr esp_err_t ESP_ERR_NVS_TYPE_MISMATCH = 0x1103;
constexpr esp_err_t ESP_ERR_NVS_INVALID_HANDLE = 0x1107;
constexpr esp_err_t ESP_ERR_NVS_INVALID_LENGTH = 0x110c;
namespace FakeNvs {
struct Value { bool blob = true; std::vector<uint8_t> bytes; };
struct Handle {
    std::string name;
    bool readOnly = false;
    std::map<std::string, Value> puts;
    std::vector<std::string> erases;
};
struct State {
    std::map<std::string, std::map<std::string, Value>> durable;
    std::map<nvs_handle_t, Handle> handles;
    nvs_handle_t nextHandle = 1;
    esp_err_t openError = ESP_OK, lengthError = ESP_OK, readError = ESP_OK;
    esp_err_t setError = ESP_OK, eraseError = ESP_OK, commitError = ESP_OK;
    bool failReadOpen = false, failWriteOpen = false, shortRead = false;
    bool commitOnError = false;
    unsigned puts = 0, erases = 0, commits = 0, readOpens = 0, writeOpens = 0;
};
inline State& state() { static State s; return s; }
inline void reset() { state() = State{}; }
inline void reboot() { state().handles.clear(); state().nextHandle = 1; }
inline Value& active() { return state().durable["ric-checkout"]["active"]; }
}
inline esp_err_t nvs_open(const char* name, nvs_open_mode_t mode, nvs_handle_t* out) {
    auto& s = FakeNvs::state();
    if (s.openError != ESP_OK) return s.openError;
    if ((mode == NVS_READONLY && s.failReadOpen) ||
        (mode == NVS_READWRITE && s.failWriteOpen)) return ESP_FAIL;
    if (mode == NVS_READONLY) {
        ++s.readOpens;
        if (!s.durable.count(name)) return ESP_ERR_NVS_NOT_FOUND;
    } else { ++s.writeOpens; s.durable[name]; }
    FakeNvs::Handle h;
    h.name = name; h.readOnly = mode == NVS_READONLY;
    *out = s.nextHandle++; s.handles[*out] = h;
    return ESP_OK;
}
inline void nvs_close(nvs_handle_t h) { FakeNvs::state().handles.erase(h); }
inline esp_err_t nvs_get_blob(nvs_handle_t h, const char* key, void* out, size_t* len) {
    auto& s = FakeNvs::state();
    if (!s.handles.count(h)) return ESP_ERR_NVS_INVALID_HANDLE;
    const esp_err_t error = out ? s.readError : s.lengthError;
    if (error != ESP_OK) return error;
    const auto& values = s.durable[s.handles[h].name];
    const auto value = values.find(key);
    if (value == values.end()) return ESP_ERR_NVS_NOT_FOUND;
    if (!value->second.blob) return ESP_ERR_NVS_TYPE_MISMATCH;
    const auto& bytes = value->second.bytes;
    if (!out) { *len = bytes.size(); return ESP_OK; }
    if (*len < bytes.size()) { *len = bytes.size(); return ESP_ERR_NVS_INVALID_LENGTH; }
    *len = bytes.size() - (s.shortRead && !bytes.empty() ? 1 : 0);
    if (*len) std::memcpy(out, bytes.data(), *len);
    return ESP_OK;
}
inline esp_err_t nvs_set_blob(nvs_handle_t h, const char* key, const void* data, size_t len) {
    auto& s = FakeNvs::state(); ++s.puts;
    if (!s.handles.count(h) || s.handles[h].readOnly) return ESP_ERR_NVS_INVALID_HANDLE;
    if (s.setError != ESP_OK) return s.setError;
    FakeNvs::Value value;
    const auto* bytes = static_cast<const uint8_t*>(data);
    value.bytes.assign(bytes, bytes + len);
    s.handles[h].puts[key] = value;
    return ESP_OK;
}
inline esp_err_t nvs_erase_key(nvs_handle_t h, const char* key) {
    auto& s = FakeNvs::state(); ++s.erases;
    if (!s.handles.count(h) || s.handles[h].readOnly) return ESP_ERR_NVS_INVALID_HANDLE;
    if (s.eraseError != ESP_OK) return s.eraseError;
    if (!s.durable[s.handles[h].name].count(key)) return ESP_ERR_NVS_NOT_FOUND;
    s.handles[h].erases.push_back(key);
    return ESP_OK;
}
inline esp_err_t nvs_commit(nvs_handle_t h) {
    auto& s = FakeNvs::state(); ++s.commits;
    if (!s.handles.count(h)) return ESP_ERR_NVS_INVALID_HANDLE;
    if (s.commitError != ESP_OK && !s.commitOnError) return s.commitError;
    auto& handle = s.handles[h]; auto& durable = s.durable[handle.name];
    for (const auto& put : handle.puts) durable[put.first] = put.second;
    for (const auto& key : handle.erases) durable.erase(key);
    handle.puts.clear(); handle.erases.clear();
    return s.commitError;
}
