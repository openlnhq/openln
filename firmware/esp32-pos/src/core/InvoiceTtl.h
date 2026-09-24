#pragma once
#include <cstdint>

// Checkout window for a payment QR, derived from the server's own invoice
// expiry (`expiresAt`, ISO-8601 UTC, on the create responses). The device
// must mirror the REAL lifetime of the invoice it presents — the wrapped
// hold lives 15 min, direct-lane invoices 60 min — instead of a fixed local
// timeout. Pure integer logic so it can be unit-tested natively
// (tests/ric-invoice-ttl.cpp) with no libc/TZ dependency.
namespace InvoiceTtl {
static constexpr uint32_t FALLBACK_SECONDS = 360;  // field missing/unparseable
static constexpr uint32_t MIN_SECONDS      = 30;   // never dead-on-arrival
static constexpr uint32_t MAX_SECONDS      = 3900; // 65 min: covers the 60-min lanes

inline bool leapYear(int y) { return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0; }

inline int daysInMonth(int y, int m) {
    static const int days[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    if (m < 1 || m > 12) return 0;
    return (m == 2 && leapYear(y)) ? 29 : days[m-1];
}

// Days from 1970-01-01 (Howard Hinnant's days_from_civil, public domain).
inline int64_t daysFromCivil(int y, int m, int d) {
    y -= (m <= 2);
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153u * static_cast<unsigned>(m + (m > 2 ? -3 : 9)) + 2u) / 5u + static_cast<unsigned>(d) - 1u;
    const unsigned doe = yoe * 365u + yoe / 4u - yoe / 100u + doy;
    return era * 146097 + static_cast<int64_t>(doe) - 719468;
}

inline bool twoDigits(const char*& p, int& out) {
    if (p[0] < '0' || p[0] > '9' || p[1] < '0' || p[1] > '9') return false;
    out = (p[0] - '0') * 10 + (p[1] - '0');
    p += 2;
    return true;
}

inline bool fourDigits(const char*& p, int& out) {
    int a, b;
    if (!twoDigits(p, a) || !twoDigits(p, b)) return false;
    out = a * 100 + b;
    return true;
}

// Parse the server's timestamp form "YYYY-MM-DDTHH:MM:SS" with optional
// fractional seconds and optional 'Z' (UTC). Offsets and any other trailing
// text are rejected: we only ever compare against the server's UTC clock.
inline bool parseIsoUtc(const char* text, int64_t& epochOut) {
    if (!text) return false;
    const char* p = text;
    int y, mo, d, h, mi, s;
    if (!fourDigits(p, y)) return false;
    if (*p++ != '-') return false;
    if (!twoDigits(p, mo)) return false;
    if (*p++ != '-') return false;
    if (!twoDigits(p, d)) return false;
    if (*p++ != 'T') return false;
    if (!twoDigits(p, h)) return false;
    if (*p++ != ':') return false;
    if (!twoDigits(p, mi)) return false;
    if (*p++ != ':') return false;
    if (!twoDigits(p, s)) return false;
    if (*p == '.') { p++; if (*p < '0' || *p > '9') return false; while (*p >= '0' && *p <= '9') p++; }
    if (*p == 'Z') p++;
    if (*p != '\0') return false;
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 59) return false;
    epochOut = daysFromCivil(y, mo, d) * 86400 + static_cast<int64_t>(h) * 3600 + static_cast<int64_t>(mi) * 60 + s;
    return true;
}

// Seconds the device may present the checkout: expiry − now, clamped to
// [MIN, MAX]. Any parse failure (or a not-yet-synced clock) falls back to
// FALLBACK_SECONDS rather than inventing a window.
inline uint32_t secondsUntil(const char* expiresAt, int64_t nowEpoch) {
    int64_t expiry;
    if (nowEpoch <= 0 || !parseIsoUtc(expiresAt, expiry)) return FALLBACK_SECONDS;
    const int64_t remaining = expiry - nowEpoch;
    if (remaining < static_cast<int64_t>(MIN_SECONDS)) return MIN_SECONDS;
    if (remaining > static_cast<int64_t>(MAX_SECONDS)) return MAX_SECONDS;
    return static_cast<uint32_t>(remaining);
}
} // namespace InvoiceTtl
