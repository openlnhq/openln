#include <cassert>
#include <cstdio>
#include "core/CheckoutJournal.h"
using Journal = CheckoutJournal;
using Result = Journal::LoadResult;
using Action = Journal::RecoveryAction;

// Pure restart policy: there is deliberately no Resume/Pay/Retry action.
static_assert(Journal::recoveryAction(Result::Missing) == Action::None, "Missing is idle");
static_assert(Journal::recoveryAction(Result::Valid) == Action::Query, "Only query after restart");
static_assert(Journal::recoveryAction(Result::Corrupt) == Action::NeedsAttention, "Do not erase corruption");
static_assert(Journal::recoveryAction(Result::Unavailable) == Action::NeedsAttention, "I/O failure is not empty");
static_assert(Journal::recoveryAction(static_cast<Result>(255)) == Action::NeedsAttention, "Unknown fails closed");
int main() {
    // Both sides of the dispatch boundary recover identically, including QR receive.
    for (auto kind : {Journal::Kind::Receive, Journal::Kind::Withdraw, Journal::Kind::SendToCard}) {
        for (bool dispatched : {false, true}) {
            FakeNvs::reset();
            assert(Journal::save(kind, "12345678-AbCd_Efg", 1, dispatched));
            FakeNvs::reboot();
            const unsigned writes = FakeNvs::state().puts;
            Journal::Record out{};
            for (unsigned poll = 0; poll < 100; ++poll) {
                assert(Journal::recoveryAction(Journal::load(out)) == Action::Query);
                assert(out.kind == kind && out.dispatched == dispatched);
            }
            assert(FakeNvs::state().puts == writes && FakeNvs::state().erases == 0);
            assert(FakeNvs::state().writeOpens == 1);
        }
    }
    std::puts("RIC journal policy: every kind and dispatch state is QUERY-only; polls never write");
}
