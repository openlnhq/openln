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

void ProvisionService::begin() {
    _ssidSet = _passSet = _tokenSet = _urlSet = _currencySet = false;

    NimBLEDevice::init("RIC");
    NimBLEDevice::setPower(9);  // 9 dBm — NimBLE 2.x takes dBm directly

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
    adv->setName("RIC");
    adv->start();

    DBG_PRINTLN("BLE: advertising as 'RIC'");
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
