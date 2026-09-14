#pragma once
#include <Preferences.h>
#include <nvs.h>
#include <cstddef>
#include <cstdint>
#include <cstring>

// One checkout, not a payment queue. Call only from the serialized checkout loop.
// Persist query identity only: never PIN, auth token, NFC secret or BOLT11.
class CheckoutJournal {
public:
    enum class Kind : uint8_t { Receive = 1, Withdraw = 2, SendToCard = 3 };
    enum class LoadResult { Missing, Valid, Corrupt, Unavailable };
    enum class RecoveryAction { None, Query, NeedsAttention };
    struct Record {
        Kind kind;
        char reference[65];
        uint64_t amountSats;
        bool dispatched;
    };
    // Wire: magic[4], version, kind, dispatched, refLength, sats LE64,
    // reference[64] (zero padded), CRC-32/ISO-HDLC LE32 over the first 80 bytes.
    // Never serialize Record itself: its native padding/layout is not durable.
    static constexpr size_t encodedSize = 84;
    static constexpr uint64_t maxAmountSats = 2147483647ULL;

    // dispatched is evidence, never authorization to re-send (even when false).
    static constexpr RecoveryAction recoveryAction(LoadResult result) {
        return result == LoadResult::Missing ? RecoveryAction::None :
               result == LoadResult::Valid ? RecoveryAction::Query : RecoveryAction::NeedsAttention;
    }

    static bool save(Kind kind, const char* reference, uint64_t amountSats, bool dispatched) {
        const size_t length = referenceLength(reference);
        if (!length || !validKind(kind) || !amountSats || amountSats > maxAmountSats) return false;
        Record previous{};
        const LoadResult result = load(previous);
        if (result == LoadResult::Corrupt || result == LoadResult::Unavailable) return false;
        if (result == LoadResult::Valid) {
            if (previous.kind != kind || previous.amountSats != amountSats ||
                std::strcmp(previous.reference, reference) || (previous.dispatched && !dispatched)) return false;
            if (previous.dispatched == dispatched) return true;
        }
        uint8_t bytes[encodedSize] = {'R', 'I', 'C', 'J', 1};
        bytes[5] = static_cast<uint8_t>(kind);
        bytes[6] = dispatched ? 1 : 0;
        bytes[7] = static_cast<uint8_t>(length);
        for (size_t i = 0; i < 8; ++i) bytes[8 + i] = uint8_t(amountSats >> (8 * i));
        std::memcpy(bytes + 16, reference, length);
        const uint32_t crc = crc32(bytes, 80);
        for (size_t i = 0; i < 4; ++i) bytes[80 + i] = uint8_t(crc >> (8 * i));
        Preferences prefs;
        if (!prefs.begin("ric-checkout", false)) return false;
        return prefs.putBytes("active", bytes, sizeof(bytes)) == sizeof(bytes);
    }

    static LoadResult load(Record& out) {
        out = Record{};
        nvs_handle_t handle;
        esp_err_t error = nvs_open("ric-checkout", NVS_READONLY, &handle);
        if (error == ESP_ERR_NVS_NOT_FOUND) return LoadResult::Missing;
        if (error != ESP_OK) return LoadResult::Unavailable;
        // Preferences::getBytesLength returns zero for BOTH errors and absence.
        // Use the built-in NVS status API so an I/O error cannot enable a new send.
        size_t length = 0;
        error = nvs_get_blob(handle, "active", nullptr, &length);
        if (error != ESP_OK || length != encodedSize) {
            nvs_close(handle);
            if (error == ESP_ERR_NVS_NOT_FOUND) return LoadResult::Missing;
            return error == ESP_OK || error == ESP_ERR_NVS_TYPE_MISMATCH
                ? LoadResult::Corrupt : LoadResult::Unavailable;
        }
        uint8_t bytes[encodedSize] = {};
        error = nvs_get_blob(handle, "active", bytes, &length);
        nvs_close(handle);
        if (error != ESP_OK || length != sizeof(bytes)) return LoadResult::Unavailable;
        if (std::memcmp(bytes, "RICJ", 4) || bytes[4] != 1) return LoadResult::Corrupt;
        const uint32_t crc = crc32(bytes, 80);
        for (size_t i = 0; i < 4; ++i)
            if (bytes[80 + i] != uint8_t(crc >> (8 * i))) return LoadResult::Corrupt;
        Record decoded{};
        decoded.kind = static_cast<Kind>(bytes[5]);
        if (!validKind(decoded.kind) || bytes[6] > 1 || bytes[7] < 16 || bytes[7] > 64)
            return LoadResult::Corrupt;
        decoded.dispatched = bytes[6] == 1;
        for (size_t i = 0; i < 8; ++i) decoded.amountSats |= uint64_t(bytes[8 + i]) << (8 * i);
        if (!decoded.amountSats || decoded.amountSats > maxAmountSats) return LoadResult::Corrupt;
        std::memcpy(decoded.reference, bytes + 16, bytes[7]);
        if (referenceLength(decoded.reference) != bytes[7]) return LoadResult::Corrupt;
        for (size_t i = bytes[7]; i < 64; ++i)
            if (bytes[16 + i] != 0) return LoadResult::Corrupt;
        out = decoded;
        return LoadResult::Valid;
    }
    // Only after confirmed terminal status or explicit operator resolution.
    // A timeout/network error is NOT terminal. On failure the caller stays blocked.
    static bool clear() {
        Record previous{};
        const LoadResult result = load(previous);
        if (result == LoadResult::Missing) return true;
        if (result == LoadResult::Unavailable) return false;
        Preferences prefs;
        if (!prefs.begin("ric-checkout", false)) return false;
        return prefs.remove("active");
    }
private:
    static bool validKind(Kind kind) {
        return kind == Kind::Receive || kind == Kind::Withdraw || kind == Kind::SendToCard;
    }
    static size_t referenceLength(const char* text) {
        if (!text) return 0;
        for (size_t i = 0; i <= 64; ++i) {
            const char c = text[i];
            if (!c) return i >= 16 ? i : 0;
            if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                  (c >= '0' && c <= '9') || c == '_' || c == '-')) return 0;
        }
        return 0;
    }
    static uint32_t crc32(const uint8_t* bytes, size_t length) {
        uint32_t crc = 0xffffffffU;
        for (size_t i = 0; i < length; ++i) {
            crc ^= bytes[i];
            for (unsigned bit = 0; bit < 8; ++bit)
                crc = (crc >> 1) ^ (0xedb88320U & (0U - (crc & 1U)));
        }
        return ~crc;
    }
};
