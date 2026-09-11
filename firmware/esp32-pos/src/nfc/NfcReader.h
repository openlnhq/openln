#pragma once
#include <Arduino.h>
#include <Adafruit_PN532_NTAG424.h>

// CN1 connector on CYD — SDA=IO22, SCL=IO27 (IO21 is the TFT backlight, not I2C)
#define PN532_SDA  22
#define PN532_SCL  27
#define PN532_IRQ  35
// RST must be a real GPIO (uint8_t; passing -1 casts to 255, causing __pinMode(255) error).
// GPIO16 is free on CYD. Wire PN532 RST here or leave unconnected — toggling a floating
// GPIO at boot is harmless; the PN532 still initialises over I2C.
#define PN532_RST  16

class NfcReader {
public:
    // Call once after hardware init
    static bool begin();

    // Attempt to re-initialise the PN532 if begin() previously failed.
    // Called periodically from idle state so a disconnected/reconnected reader
    // (loose wire in retail) self-heals without a reboot.  No-op if already ready.
    // Returns true if the reader is now ready.
    static bool reinit();

    // Phase 1 — detect a card and capture its UID.
    // Non-blocking relative to the main loop (300ms RF window).
    // Returns true if a card entered the field. Must be followed by readNdef().
    static bool detectCard(String& outUid);

    // Phase 2 — read NDEF URL from the card detected in the last detectCard() call.
    // Call immediately after detectCard() while the card is still in the field.
    // Returns the normalised HTTPS URL, or "" on failure.
    static String readNdef();

    // Expose the PN532 instance for NfcWriter (card provisioning/wiping).
    static Adafruit_PN532& getNfc() { return _nfc; }

private:
    static Adafruit_PN532 _nfc;
    static bool           _ready;

    // Stored UID from the last detectCard() call
    static uint8_t  _uid[7];
    static uint8_t  _uidLen;

    // Read NDEF URL from an NTAG 424 DNA (Bolt Card) using the
    // Adafruit_PN532_NTAG424 library's ISOReadFile.
    static String readNdefUrlNtag424();

    // Normalize lnurlw:// and lnurl:// to https://
    static String normalizeUrl(const String& raw);

    // UID bytes to hex string
    static String uidToHex(uint8_t* uid, uint8_t len);

    // Toggle PN532 RF field (RFConfiguration 0x32, CfgItem 0x01).
    // Used between ISOReadFile retries to hard-reset the card's internal state.
    static void rfFieldSet(bool on);

    // Lower the PN532 receiver gain (RFConfiguration 0x32, CfgItem 0x0A, full
    // 11-byte block). Reduces RxGain 38dB→23dB so the demodulator does not
    // saturate on the strong signal a card returns when touching the antenna
    // (the close-range / "tap" over-coupling problem). TX power is unchanged.
    static void rfReduceRxGain();
};
