#include "../ui/Theme.h"
#include "ProvisionService.h"
#include "../config/Config.h"

NimBLEServer*         ProvisionService::_server      = nullptr;
NimBLECharacteristic* ProvisionService::_statusChar  = nullptr;
String ProvisionService::ssid;
String ProvisionService::pass;
String ProvisionService::token;
String ProvisionService::serverUrl;
String ProvisionService::currency = "usd";
bool ProvisionService::_ssidSet     = false;
bool ProvisionService::_passSet     = false;
bool ProvisionService::_tokenSet    = false;
bool ProvisionService::_urlSet      = false;
bool ProvisionService::_currencySet = false;

// ──────────────────────────────────────────────────────────────────
// Write-callback helper
// ──────────────────────────────────────────────────────────────────
class WriteCallback : public NimBLECharacteristicCallbacks {
public:
    explicit WriteCallback(String& target, bool& flag)
        : _target(target), _flag(flag) {}

    void onWrite(NimBLECharacteristic* pChar, NimBLEConnInfo& connInfo) override {
        _target = pChar->getValue().c_str();
        _flag   = true;
        DBG_PRINTF("BLE: char written (%d bytes)\n", (int)pChar->getValue().length());
        ProvisionService::checkComplete();
    }

private:
    String& _target;
    bool&   _flag;
};

// ──────────────────────────────────────────────────────────────────

String ProvisionService::_deviceName = "RIC";

void ProvisionService::begin() {
    _ssidSet = _passSet = _tokenSet = _urlSet = _currencySet = false;

    // Unique per unit: "RIC-XXXX" from the last two bytes of the BLE address.
    // A room full of terminals (partner workshop, shop with several tills)
    // must let the person linking pick THIS one from the phone's chooser.
    // The web app matches namePrefix "RIC", so "RIC" (older firmware) and
    // "RIC-XXXX" both pair. Init name is a placeholder; the real one follows.
    NimBLEDevice::init("RIC");
    NimBLEDevice::setPower(9);  // 9 dBm — NimBLE 2.x takes dBm directly
    {
        const std::string addr = NimBLEDevice::getAddress().toString(); // "14:2b:2f:eb:b2:f2"
        std::string tail;
        for (char c : addr) if (c != ':') tail += (char)toupper((unsigned char)c);
        _deviceName = String("RIC-") + (tail.size() >= 4 ? tail.substr(tail.size() - 4).c_str() : "0000");
        NimBLEDevice::setDeviceName(_deviceName.c_str());
    }

    _server = NimBLEDevice::createServer();

    NimBLEService* svc = _server->createService(BLE_SERVICE_UUID);

    auto makeWriteChar = [&](const char* uuid, String& target, bool& flag) {
        NimBLECharacteristic* c = svc->createCharacteristic(uuid, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
        c->setCallbacks(new WriteCallback(target, flag));
        return c;
    };

    makeWriteChar(BLE_CHAR_SSID,     ssid,      _ssidSet);
    makeWriteChar(BLE_CHAR_PASS,     pass,      _passSet);
    makeWriteChar(BLE_CHAR_TOKEN,    token,     _tokenSet);
    makeWriteChar(BLE_CHAR_URL,      serverUrl, _urlSet);
    makeWriteChar(BLE_CHAR_CURRENCY, currency,  _currencySet);

    _statusChar = svc->createCharacteristic(
        BLE_CHAR_STATUS,
        NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY
    );
    _statusChar->setValue("ready");

    NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
    adv->addServiceUUID(BLE_SERVICE_UUID);
    adv->setName(_deviceName.c_str());
    const bool started = adv->start();

    // Always on serial (not DBG_): provisioning is the one moment a field
    // partner is staring at a terminal wondering why the phone sees nothing.
    Serial.printf("RIC ble: advertising=%s name=%s addr=%s power=%d heap=%u\n",
                  started ? "on" : "FAILED", _deviceName.c_str(), NimBLEDevice::getAddress().toString().c_str(),
                  NimBLEDevice::getPower(), ESP.getFreeHeap());
}

void ProvisionService::stop() {
    NimBLEDevice::getAdvertising()->stop();
    NimBLEDevice::deinit(true);
    _server = nullptr;
    _statusChar = nullptr;
}

void ProvisionService::setStatus(const char* status) {
    if (!_statusChar) return;
    _statusChar->setValue(status);
    _statusChar->notify();
    DBG_PRINTF("BLE status: %s\n", status);
}

bool ProvisionService::isComplete() {
    return _ssidSet && _passSet && _tokenSet && _urlSet && _currencySet;
}

void ProvisionService::checkComplete() {
    // Called each time any char is written — just log progress
    DBG_PRINTF("BLE progress: ssid=%d pass=%d token=%d url=%d currency=%d\n",
                  _ssidSet, _passSet, _tokenSet, _urlSet, _currencySet);
}
