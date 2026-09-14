#pragma once
#include <Arduino.h>
#include <Wire.h>
constexpr uint8_t PN532_MIFARE_ISO14443A = 0;
class Adafruit_PN532 {
public:
    const uint8_t irq, reset;
    Adafruit_PN532(uint8_t irqPin, uint8_t resetPin, TwoWire* = &Wire)
        : irq(irqPin), reset(resetPin) {}
    bool begin();
    uint32_t getFirmwareVersion();
    bool SAMConfig();
    bool setPassiveActivationRetries(uint8_t retries);
    bool readPassiveTargetID(uint8_t baud, uint8_t* uid, uint8_t* count, uint16_t timeout = 0);
    bool sendCommandCheckAck(uint8_t* cmd, uint8_t count, uint16_t timeout = 100);
    uint8_t ntag424_ISOReadFile(uint8_t* buffer, int maxsize);
};
