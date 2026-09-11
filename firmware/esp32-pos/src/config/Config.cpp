#include "../ui/Theme.h"
#include "Config.h"
#include <nvs.h>
#include <nvs_flash.h>

String Config::ssid;
String Config::pass;
String Config::token;
String Config::serverUrl;
String Config::currency;

// Raw NVS helpers — bypass Preferences wrapper whose end() skips nvs_commit().
static esp_err_t nvsOpen(nvs_handle_t& h, nvs_open_mode_t mode) {
    return nvs_open("bitpos", mode, &h);
}

static String nvsGetStr(nvs_handle_t h, const char* key, const char* def = "") {
    size_t len = 0;
    if (nvs_get_str(h, key, nullptr, &len) != ESP_OK) return def;
    char* buf = new char[len];
    nvs_get_str(h, key, buf, &len);
    String s(buf);
    delete[] buf;
    return s;
}

bool Config::isProvisioned() {
    nvs_handle_t h;
    if (nvsOpen(h, NVS_READONLY) != ESP_OK) return false;
    size_t len = 0;
    bool ok = nvs_get_str(h, "token", nullptr, &len) == ESP_OK && len > 1;
    nvs_close(h);
    return ok;
}

void Config::save(const String& s, const String& p, const String& t,
                  const String& u, const String& c) {
    ssid = s; pass = p; token = t; serverUrl = u; currency = c;

    nvs_handle_t h;
    esp_err_t err = nvsOpen(h, NVS_READWRITE);
    if (err != ESP_OK) {
        DBG_PRINTF("Config: nvs_open FAILED (%d)\n", err);
        return;
    }
    nvs_set_str(h, "ssid",      s.c_str());
    nvs_set_str(h, "pass",      p.c_str());
    nvs_set_str(h, "token",     t.c_str());
    nvs_set_str(h, "serverUrl", u.c_str());
    nvs_set_str(h, "currency",  c.c_str());
    err = nvs_commit(h);
    DBG_PRINTF("Config: nvs_commit %s\n", err == ESP_OK ? "OK" : "FAILED");
    nvs_close(h);
}

void Config::saveWifi(const String& s, const String& p) {
    ssid = s; pass = p;

    nvs_handle_t h;
    esp_err_t err = nvsOpen(h, NVS_READWRITE);
    if (err != ESP_OK) {
        DBG_PRINTF("Config::saveWifi: nvs_open FAILED (%d)\n", err);
        return;
    }
    nvs_set_str(h, "ssid", s.c_str());
    nvs_set_str(h, "pass", p.c_str());
    err = nvs_commit(h);
    DBG_PRINTF("Config::saveWifi: nvs_commit %s (ssid=%s)\n",
                  err == ESP_OK ? "OK" : "FAILED", s.c_str());
    nvs_close(h);
}

void Config::clear() {
    ssid = ""; pass = ""; token = ""; serverUrl = ""; currency = "";
    nvs_handle_t h;
    if (nvsOpen(h, NVS_READWRITE) != ESP_OK) return;
    nvs_erase_all(h);
    nvs_commit(h);
    nvs_close(h);
}

void Config::load() {
    nvs_handle_t h;
    if (nvsOpen(h, NVS_READONLY) != ESP_OK) return;
    ssid      = nvsGetStr(h, "ssid");
    pass      = nvsGetStr(h, "pass");
    token     = nvsGetStr(h, "token");
    serverUrl = nvsGetStr(h, "serverUrl");
    currency  = nvsGetStr(h, "currency", "usd");
    nvs_close(h);
}
