#include <cassert>
#include <cstdint>
#include <cstdio>
#include "core/QrPolicy.h"
#if __has_include("core/CheckoutPolicy.h")
#include "core/CheckoutPolicy.h"
#else
#error "CheckoutPolicy.h is required for a shared, ten-minute checkout deadline"
#endif
int main() {
    assert(RicQr::versionForAlphaLength(300) == 9);
    assert(RicQr::versionForAlphaLength(1050) == 19);
    assert(RicQr::versionForAlphaLength(1249) == 20);
    assert(RicQr::versionForAlphaLength(1250) == 0);
    assert(RicQr::versionForAlphaLength(0) == 0);
    assert(RicQr::isAlphanumeric("LNBC1: /123"));
    assert(!RicQr::isAlphanumeric("LNBC?123"));
    assert(RicCheckout::windowMs == 600000 && "Checkout must allow ten minutes, not one");
    assert(RicCheckout::remainingSeconds(1000, 1000, 600000) == 600);
    assert(RicCheckout::remainingSeconds(2000, 1000, 600000) == 599);
    assert(RicCheckout::remainingSeconds(601000, 1000, 600000) == 0);
    const uint32_t beforeWrap = UINT32_MAX - 500;
    assert(RicCheckout::remainingSeconds(beforeWrap, beforeWrap, 600000) == 600);
    assert(RicCheckout::remainingSeconds(499, beforeWrap, 600000) == 599);
    assert(RicCheckout::remainingSeconds(beforeWrap + 600000U, beforeWrap, 600000) == 0);
    RicCheckout::Flow flow;
    assert(flow.canSubmit());
    flow.dispatch();
    assert(!flow.canSubmit());
    assert(!flow.canAbandon(0));
    assert(!flow.canAbandon(600000));
    flow.networkLost();
    assert(flow.phase == RicCheckout::Phase::Reconciling);
    assert(!flow.canSubmit());
    assert(!flow.terminal());
    flow.observe("created");
    assert(!flow.terminal() && !flow.canSubmit());
    flow.observe("accepted");
    assert(!flow.terminal() && !flow.canSubmit());
    flow.observe("paid");
    assert(flow.phase == RicCheckout::Phase::Paid);
    assert(flow.terminal() && !flow.canSubmit());
    RicCheckout::Flow unsubmitted;
    assert(!unsubmitted.canAbandon(599999));
    assert(unsubmitted.canAbandon(600000));
    unsubmitted.observe("failed");
    assert(unsubmitted.phase == RicCheckout::Phase::Declined);
    assert(!unsubmitted.canSubmit());
    puts("Checkout: deadlines, no duplicate dispatch, outage and settlement policy pass");
}
