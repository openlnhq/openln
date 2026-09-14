#pragma once
#include <cstdint>
#include <cstring>

namespace RicCheckout {
// This is the customer presentation window, not permission to abandon a send.
constexpr uint32_t windowMs = 10U * 60U * 1000U;
inline uint32_t remainingSeconds(uint32_t now, uint32_t start, uint32_t window) {
    const uint32_t elapsed = now - start;
    if (elapsed >= window) return 0;
    return (window - elapsed + 999U) / 1000U;
}
enum class Phase { Waiting, Submitted, Reconciling, Paid, Declined };
struct Flow {
    Phase phase = Phase::Waiting;
    bool canSubmit() const { return phase == Phase::Waiting; }
    bool terminal() const { return phase == Phase::Paid || phase == Phase::Declined; }
    bool canAbandon(uint32_t elapsedMs) const {
        return phase == Phase::Waiting && elapsedMs >= windowMs;
    }
    void dispatch() { if (canSubmit()) phase = Phase::Submitted; }
    void networkLost() { if (!terminal() && phase != Phase::Waiting) phase = Phase::Reconciling; }
    void observe(const char* status) {
        if (!status || terminal()) return;
        if (!std::strcmp(status, "paid")) phase = Phase::Paid;
        else if (!std::strcmp(status, "failed") || !std::strcmp(status, "cancelled") || !std::strcmp(status, "expired")) phase = Phase::Declined;
        else if (!std::strcmp(status, "accepted") || !std::strcmp(status, "forwarding") || !std::strcmp(status, "forwarded") || !std::strcmp(status, "processing")) phase = Phase::Submitted;
        else if (!std::strcmp(status, "needs_reconciliation")) phase = Phase::Reconciling;
    }
};
}
