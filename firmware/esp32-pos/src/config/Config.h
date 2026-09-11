#pragma once
#include <Arduino.h>

class Config {
public:
    static bool isProvisioned();
    static void save(const String& ssid, const String& pass,
                     const String& token, const String& serverUrl,
                     const String& currency);
    static void saveWifi(const String& ssid, const String& pass);
    static void clear();
    static void load();

    static String ssid;
    static String pass;
    static String token;
    static String serverUrl;
    static String currency;
};
