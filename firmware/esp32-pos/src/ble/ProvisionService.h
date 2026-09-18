#pragma once
#include <Arduino.h>
#include <NimBLEDevice.h>

// BLE UUIDs — must match Part 2 (posbox-ble.ts)
#define BLE_SERVICE_UUID  "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_CHAR_SSID     "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_CHAR_PASS     "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_CHAR_TOKEN    "6e400004-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_CHAR_URL      "6e400005-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_CHAR_CURRENCY "6e400006-b5a3-f393-e0a9-e50e24dcca9e"
#define BLE_CHAR_STATUS   "6e400007-b5a3-f393-e0a9-e50e24dcca9e"

class ProvisionService {
public:
    static void begin();
    static void stop();

    // Write a status string to the notify characteristic
    static void setStatus(const char* status);

    // Returns true once all six provisioning values have been received
    static bool isComplete();

    // Returns true if begin() has been called and BLE stack is active
    static bool isActive() { return _statusChar != nullptr; }

    // Advertised name, e.g. "RIC-B2F2" (unique per unit). Valid after begin().
    static const String& deviceName() { return _deviceName; }

    // Values set by BLE writes
    static String ssid;
    static String pass;
    static String token;
    static String serverUrl;
    static String currency;

    // Called by WriteCallback (defined in .cpp) after each BLE write
    static void checkComplete();

private:
    static String                _deviceName;
    static NimBLEServer*         _server;
    static NimBLECharacteristic* _statusChar;
    static bool _ssidSet, _passSet, _tokenSet, _urlSet, _currencySet;
};
