#include "NfcWriter.h"
#include "../nfc/NfcReader.h"

const uint8_t NfcWriter::FACTORY_KEY[16] = {0};

// ── Hex helpers ────────────────────────────────────────────────────────────

int NfcWriter::hexToBytes(const String& hex, uint8_t* out, int maxLen) {
    int len = hex.length() / 2;
    if (len > maxLen) len = maxLen;
    for (int i = 0; i < len; i++) {
        char h = hex.charAt(i * 2);
        char l = hex.charAt(i * 2 + 1);
        uint8_t hi = (h >= '0' && h <= '9') ? h - '0' :
                     (h >= 'a' && h <= 'f') ? h - 'a' + 10 :
                     (h >= 'A' && h <= 'F') ? h - 'A' + 10 : 0;
        uint8_t lo = (l >= '0' && l <= '9') ? l - '0' :
                     (l >= 'a' && l <= 'f') ? l - 'a' + 10 :
                     (l >= 'A' && l <= 'F') ? l - 'A' + 10 : 0;
        out[i] = (hi << 4) | lo;
    }
    return len;
}

void NfcWriter::hexKeyToBytes(const String& hex, uint8_t* out) {
    hexToBytes(hex, out, 16);
}

// ── Write (provision) ──────────────────────────────────────────────────────

String NfcWriter::writeCard(const ProvisionData& data,
                            void (*onStep)(const char* label, bool done)) {
    Adafruit_PN532& nfc = NfcReader::getNfc();

    // Parse NDEF file (max 256 bytes)
    uint8_t ndefBuf[256];
    int ndefLen = hexToBytes(data.ndefFileHex, ndefBuf, sizeof(ndefBuf));
    if (ndefLen == 0) return "Invalid NDEF data";

    // Parse SDM settings (15 bytes)
    uint8_t sdmBuf[16];
    int sdmLen = hexToBytes(data.sdmSettingsHex, sdmBuf, sizeof(sdmBuf));
    if (sdmLen == 0) return "Invalid SDM settings";

    // Parse all 5 keys
    uint8_t k0[16], k1[16], k2[16], k3[16], k4[16];
    hexKeyToBytes(data.k0, k0);
    hexKeyToBytes(data.k1, k1);
    hexKeyToBytes(data.k2, k2);
    hexKeyToBytes(data.k3, k3);
    hexKeyToBytes(data.k4, k4);

    // Step 1: Write NDEF file (PLAIN mode, no auth needed)
    onStep("Writing NDEF...", false);
    delay(250);  // let card settle after RATS

    // Select the NTAG424 application (AID: D2760000850101) — this makes
    // the NDEF file (file 0x02) the active file for ISOUpdateBinary.
    uint8_t aid[7] = {0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01};
    if (!nfc.ntag424_ISOSelectFileByDFN(aid)) {
        return "App select failed";
    }

    if (!nfc.ntag424_ISOUpdateBinary(ndefBuf, ndefLen)) {
        return "NDEF write failed";
    }

    // Step 2: Authenticate with factory key (all zeros)
    onStep("Authenticating...", false);
    uint8_t authCmd = 0x71;  // AuthenticateEV2First
    if (!nfc.ntag424_Authenticate((uint8_t*)FACTORY_KEY, 0, authCmd)) {
        return "Auth failed (card already provisioned?)";
    }

    // Step 3: Configure SDM (CommMode.FULL)
    onStep("Configuring SDM...", false);
    uint8_t cfsResult = nfc.ntag424_ChangeFileSettings(0x02, sdmBuf, sdmLen,
                                                       NTAG424_COMM_MODE_FULL);
    if (cfsResult == 0) {
        return "SDM config failed";
    }

    // Steps 4-8: Rotate all 5 keys (CommMode.FULL)
    uint8_t* keys[5] = {k1, k2, k3, k4, k0};
    uint8_t keyNums[5] = {1, 2, 3, 4, 0};
    const char* keyNames[5] = {"Writing key K1...", "Writing key K2...",
                               "Writing key K3...", "Writing key K4...",
                               "Writing master key K0..."};

    for (int i = 0; i < 5; i++) {
        onStep(keyNames[i], false);
        if (!nfc.ntag424_ChangeKey((uint8_t*)FACTORY_KEY, keys[i], keyNums[i])) {
            char buf[40];
            snprintf(buf, sizeof(buf), "Key K%d change failed", keyNums[i]);
            return buf;
        }
    }

    // Clear the card target so the next detectCard starts fresh
    nfc.SAMConfig();

    onStep("Card written", true);
    return "";
}

// ── Wipe ───────────────────────────────────────────────────────────────────

String NfcWriter::wipeCard(const WipeData& data,
                            void (*onStep)(const char* label, bool done)) {
    Adafruit_PN532& nfc = NfcReader::getNfc();

    // Parse factory settings
    uint8_t factoryBuf[16];
    int factoryLen = hexToBytes(data.factorySettingsHex, factoryBuf, sizeof(factoryBuf));
    if (factoryLen == 0) return "Invalid factory settings";

    // Parse keys (we need k0 to authenticate, and k1-k4 to reset them)
    uint8_t k0[16], k1[16], k2[16], k3[16], k4[16];
    hexKeyToBytes(data.k0, k0);
    hexKeyToBytes(data.k1, k1);
    hexKeyToBytes(data.k2, k2);
    hexKeyToBytes(data.k3, k3);
    hexKeyToBytes(data.k4, k4);

    // Step 1: Select the NTAG424 application and authenticate with the card's master key (k0)
    onStep("Authenticating...", false);
    delay(250);

    // Select the application first (needed after the NDEF read)
    uint8_t aid[7] = {0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01};
    if (!nfc.ntag424_ISOSelectFileByDFN(aid)) {
        return "App select failed";
    }

    uint8_t authCmd = 0x71;  // AuthenticateEV2First
    if (!nfc.ntag424_Authenticate(k0, 0, authCmd)) {
        return "Auth failed (wrong key or already wiped?)";
    }

    // Step 2: Reset SDM to factory settings (CommMode.FULL)
    onStep("Disabling SDM...", false);
    uint8_t cfsResult = nfc.ntag424_ChangeFileSettings(0x02, factoryBuf, factoryLen,
                                                       NTAG424_COMM_MODE_FULL);
    if (cfsResult == 0) {
        return "SDM reset failed";
    }

    // Steps 3-7: Reset all keys back to factory (all zeros)
    uint8_t* oldKeys[5] = {k1, k2, k3, k4, k0};
    uint8_t keyNums[5] = {1, 2, 3, 4, 0};
    const char* keyNames[5] = {"Resetting K1...", "Resetting K2...",
                               "Resetting K3...", "Resetting K4...",
                               "Resetting K0..."};

    for (int i = 0; i < 5; i++) {
        onStep(keyNames[i], false);
        if (!nfc.ntag424_ChangeKey(oldKeys[i], (uint8_t*)FACTORY_KEY, keyNums[i])) {
            char buf[40];
            snprintf(buf, sizeof(buf), "Key K%d reset failed", keyNums[i]);
            return buf;
        }
    }

    // Step 8: Select the app again (ChangeKey may have invalidated the session)
    // then clear the NDEF file (write zeros)
    onStep("Clearing NDEF...", false);
    if (!nfc.ntag424_ISOSelectFileByDFN(aid)) {
        // If select fails, the card is still wiped (keys + SDM reset) — NDEF clear is cosmetic
        nfc.SAMConfig();
        onStep("Card wiped", true);
        return "";
    }

    // Write a minimal empty NDEF: NLEN=0 (2 bytes)
    uint8_t clearNdef[2] = {0x00, 0x00};
    nfc.ntag424_ISOUpdateBinary(clearNdef, 2);

    nfc.SAMConfig();
    onStep("Card wiped", true);
    return "";
}
