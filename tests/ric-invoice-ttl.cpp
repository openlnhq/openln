#include <cassert>
#include <cstdint>
#include <iostream>
#include "core/InvoiceTtl.h"

// Native unit test for the checkout-window policy (no Arduino deps).
// Run by tests/ric-firmware-policy.test.mjs with g++ -std=c++17 -Wall -Wextra -Werror.
int main() {
    using namespace InvoiceTtl;
    int64_t t = -1;

    // parseIsoUtc — exact epochs (UTC).
    assert(parseIsoUtc("1970-01-01T00:00:00Z", t) && t == 0);
    assert(parseIsoUtc("2026-09-24T05:41:00Z", t) && t == 1790228460);
    assert(parseIsoUtc("2000-02-29T12:34:56Z", t) && t == 951827696); // leap day

    // Fractional seconds ignored; trailing 'Z' optional.
    assert(parseIsoUtc("2026-09-24T05:41:00.123Z", t) && t == 1790228460);
    assert(parseIsoUtc("2026-09-24T05:41:00.9Z", t) && t == 1790228460);
    assert(parseIsoUtc("2026-09-24T05:41:00", t) && t == 1790228460);

    // Rejections — anything the server must never send, or garbage.
    assert(!parseIsoUtc(nullptr, t));
    assert(!parseIsoUtc("", t));
    assert(!parseIsoUtc("junk", t));
    assert(!parseIsoUtc("2026-09-24", t));
    assert(!parseIsoUtc("2026-09-24T05:41", t));
    assert(!parseIsoUtc("2026-09-24 05:41:00Z", t));      // missing 'T'
    assert(!parseIsoUtc("2026-9-24T05:41:00Z", t));       // 1-digit month
    assert(!parseIsoUtc("2026-00-01T00:00:00Z", t));      // month 0
    assert(!parseIsoUtc("2026-13-01T00:00:00Z", t));      // month 13
    assert(!parseIsoUtc("2026-02-29T00:00:00Z", t));      // 2026 is not a leap year
    assert(!parseIsoUtc("2024-02-30T00:00:00Z", t));      // day 30 in February
    assert(!parseIsoUtc("2026-09-24T24:00:00Z", t));      // hour 24
    assert(!parseIsoUtc("2026-09-24T05:60:00Z", t));      // minute 60
    assert(!parseIsoUtc("2026-09-24T05:41:60Z", t));      // second 60
    assert(!parseIsoUtc("2026-09-24T05:41:00+02:00", t)); // offsets unsupported
    assert(!parseIsoUtc("2026-09-24T05:41:00Zx", t));     // trailing junk
    assert(!parseIsoUtc("2026-09-24T05:41:00.Z", t));     // empty fraction

    // secondsUntil — exact value, clamps, fallback.
    const char* expiry = "2026-09-24T05:41:00Z"; // epoch 1790228460
    assert(secondsUntil(expiry, 1790228460 - 900) == 900);
    assert(secondsUntil(expiry, 1790228460 - 30) == 30);
    assert(secondsUntil(expiry, 1790228460 - 29) == MIN_SECONDS);
    assert(secondsUntil(expiry, 1790228460) == MIN_SECONDS);        // already past
    assert(secondsUntil(expiry, 1790228460 + 5000) == MIN_SECONDS);
    assert(secondsUntil(expiry, 1790228460 - 3900) == MAX_SECONDS); // boundary
    assert(secondsUntil(expiry, 1790228460 - 3901) == MAX_SECONDS);
    assert(secondsUntil(expiry, 1790228460 - 4000) == MAX_SECONDS);
    assert(secondsUntil("garbage", 1790228460) == FALLBACK_SECONDS);
    assert(secondsUntil(nullptr, 1790228460) == FALLBACK_SECONDS);
    assert(secondsUntil(expiry, 0) == FALLBACK_SECONDS);            // clock not synced
    assert(secondsUntil(expiry, -5) == FALLBACK_SECONDS);

    assert(MIN_SECONDS < FALLBACK_SECONDS && FALLBACK_SECONDS < MAX_SECONDS);
    std::cout << "ric-invoice-ttl: all assertions passed\n";
    return 0;
}
