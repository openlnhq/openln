#pragma once
#include <Arduino.h>
#include <Adafruit_PN532_NTAG424.h>

/**
 * NFC card writer — provisions and wipes NTAG424 DNA Bolt Cards.
 *
 * The server pre-builds the NDEF file + SDM settings (hex-encoded) and
 * returns the 5 AES keys.  The device just:
 *   1. ISOUpdateBinary(ndefFile)  — write NDEF (PLAIN, no auth)
 *   2. Authenticate(factoryKey=0)  — auth with all-zero key
 *   3. ChangeFileSettings(SDM)     — enable SDM (FULL)
 *   4. ChangeKey ×5               — rotate all keys from factory to provisioned
 *
 * Wipe reverses: auth with provisioned key 0, reset SDM, reset all keys to
 * factory, clear NDEF.
 */

struct ProvisionData {
    String cardId;
    String ndefFileHex;     // hex-encoded NDEF file bytes
    String sdmSettingsHex;  // hex-encoded SDM file settings
    String k0, k1, k2, k3, k4;  // 5 AES keys (32 hex chars each)
};

struct WipeData {
    String cardId;
    String k0, k1, k2, k3, k4;
    String factorySettingsHex;  // hex-encoded factory file settings
};

class NfcWriter {
public:
    // Write a provisioned card. Call after NfcReader::detectCard() succeeds.
    // onStep is called at each stage for UI feedback.
    // Returns "" on success, error message on failure.
    static String writeCard(const ProvisionData& data,
                            void (*onStep)(const char* label, bool done));

    // Wipe a provisioned card back to factory state.
    // Returns "" on success, error message on failure.
    static String wipeCard(const WipeData& data,
                           void (*onStep)(const char* label, bool done));

private:
    static const uint8_t FACTORY_KEY[16];

    // Parse a hex string into a byte buffer. Returns the byte count.
    static int hexToBytes(const String& hex, uint8_t* out, int maxLen);

    // Parse a 32-char hex key into 16 bytes.
    static void hexKeyToBytes(const String& hex, uint8_t* out);
};
