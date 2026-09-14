#pragma once
#include "HostNfc.h"
class TwoWire {
public:
    bool begin(int sda, int scl) {
        HostNfc::state.sda = sda; HostNfc::state.scl = scl; return true;
    }
    void setTimeOut(uint16_t ms) { HostNfc::state.wireTimeout = ms; }
    void beginTransmission(uint8_t address) { HostNfc::state.address = address; }
    uint8_t endTransmission() {
        return HostNfc::state.devicePresent && HostNfc::state.address == 0x24 ? 0 : 2;
    }
    uint8_t requestFrom(uint8_t, uint8_t count) { return count; }
    int available() { return 0; }
    int read() { return -1; }
};
extern TwoWire Wire;
