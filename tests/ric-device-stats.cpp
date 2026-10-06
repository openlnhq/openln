#include <cassert>
#include <cstring>
#include <iostream>
#include "core/DeviceStats.h"

// Native unit test for the reset-reason mapping (no Arduino deps).
// Run by tests/ric-firmware-policy.test.mjs with g++ -std=c++17 -Wall -Wextra -Werror.
int main() {
    using DeviceStats::resetReasonName;

    // esp_reset_reason_t values → stable telemetry names (the dashboard keys off these).
    assert(!std::strcmp(resetReasonName(1), "poweron"));   // power cut / unplug
    assert(!std::strcmp(resetReasonName(2), "ext"));
    assert(!std::strcmp(resetReasonName(3), "sw"));        // deliberate restart
    assert(!std::strcmp(resetReasonName(4), "panic"));     // crash
    assert(!std::strcmp(resetReasonName(5), "intwdt"));
    assert(!std::strcmp(resetReasonName(6), "taskwdt"));
    assert(!std::strcmp(resetReasonName(7), "wdt"));
    assert(!std::strcmp(resetReasonName(8), "deepsleep"));
    assert(!std::strcmp(resetReasonName(9), "brownout"));  // power dip
    assert(!std::strcmp(resetReasonName(10), "sdio"));

    // Anything outside the known enum must degrade to "unknown", never to junk.
    assert(!std::strcmp(resetReasonName(0), "unknown"));
    assert(!std::strcmp(resetReasonName(11), "unknown"));
    assert(!std::strcmp(resetReasonName(-1), "unknown"));
    assert(!std::strcmp(resetReasonName(999), "unknown"));

    // Every name must satisfy the server telemetry contract: [a-zA-Z0-9_-]{1,32}.
    for (int code = -2; code <= 12; code++) {
        const char* name = resetReasonName(code);
        assert(name != nullptr && *name != '\0');
        size_t len = 0;
        for (const char* p = name; *p; p++) {
            const bool ok = (*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
                            (*p >= '0' && *p <= '9') || *p == '_' || *p == '-';
            assert(ok);
            len++;
        }
        assert(len >= 1 && len <= 32);
    }

    std::cout << "ric-device-stats: all assertions passed\n";
    return 0;
}
