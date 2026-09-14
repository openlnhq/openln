#include <cassert>
#include <cstdio>
#include <cstring>
#include "core/CheckoutJournal.h"
using Journal = CheckoutJournal;
using Kind = Journal::Kind;
using Result = Journal::LoadResult;
static const char* hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

static void restartRestoresQueryIdentity() {
    FakeNvs::reset();
    assert(Journal::save(Kind::Receive, hash, 2147483647ULL, false));
    FakeNvs::reboot();
    Journal::Record out{};
    assert(Journal::load(out) == Result::Valid);
    assert(out.kind == Kind::Receive);
    assert(std::strcmp(out.reference, hash) == 0);
    assert(out.amountSats == 2147483647ULL);
    assert(!out.dispatched);
    assert(FakeNvs::state().handles.empty());
}
static void assertEmpty(const Journal::Record& out) {
    assert(static_cast<uint8_t>(out.kind) == 0);
    assert(out.amountSats == 0 && !out.dispatched);
    for (char c : out.reference) assert(c == 0);
}

static void checksum(std::vector<uint8_t>& bytes) {
    // Independent test implementation, CRC-32/ISO-HDLC (123456789 -> cbf43926).
    uint32_t crc = 0xffffffffU;
    for (size_t i = 0; i < 80; ++i) {
        crc ^= bytes[i];
        for (unsigned bit = 0; bit < 8; ++bit)
            crc = (crc >> 1) ^ (crc & 1 ? 0xedb88320U : 0);
    }
    crc ^= 0xffffffffU;
    for (size_t i = 0; i < 4; ++i) bytes[80 + i] = uint8_t(crc >> (8 * i));
}

static void corruptionNeverRestoresAnIdentity() {
    FakeNvs::reset();
    assert(Journal::save(Kind::Withdraw, hash, 123, true));
    const auto original = FakeNvs::active().bytes;
    for (size_t i = 0; i < original.size(); ++i) {
        for (unsigned bit = 0; bit < 8; ++bit) {
            FakeNvs::active().bytes = original;
            FakeNvs::active().bytes[i] ^= uint8_t(1U << bit);
            Journal::Record out{}; out.amountSats = 99; std::strcpy(out.reference, "stale");
            assert(Journal::load(out) == Result::Corrupt);
            assertEmpty(out);
            assert(FakeNvs::state().handles.empty());
        }
    }
    for (size_t size = 0; size < original.size(); ++size) {
        FakeNvs::active().bytes.assign(original.begin(), original.begin() + size);
        Journal::Record out{};
        assert(Journal::load(out) == Result::Corrupt);
        assertEmpty(out);
    }
    FakeNvs::active().bytes = original;
    FakeNvs::active().bytes.push_back(0);
    Journal::Record out{};
    assert(Journal::load(out) == Result::Corrupt);
    FakeNvs::active().bytes = original;
    FakeNvs::active().bytes[4] = 2; // A valid CRC must not accept a future schema.
    checksum(FakeNvs::active().bytes);
    assert(Journal::load(out) == Result::Corrupt);
    assertEmpty(out);
}

static void inputValidationPrecedesFlashWrites() {
    const char* invalid[] = {nullptr, "", "123456", "123456789012345", "123456789012345 ",
        "123456789012345/", "123456789012345.", "123456789012345\n", "123456789012345\x80"};
    FakeNvs::reset();
    for (const char* reference : invalid) assert(!Journal::save(Kind::Receive, reference, 1, false));
    const char unterminated[65] = {
        'A','A','A','A','A','A','A','A','A','A','A','A','A','A','A','A',
        'A','A','A','A','A','A','A','A','A','A','A','A','A','A','A','A',
        'A','A','A','A','A','A','A','A','A','A','A','A','A','A','A','A',
        'A','A','A','A','A','A','A','A','A','A','A','A','A','A','A','A','A'};
    assert(!Journal::save(Kind::Receive, unterminated, 1, false));
    const uint64_t badAmounts[] = {0, 2147483648ULL, 4294967296ULL, UINT64_MAX};
    for (uint64_t amount : badAmounts)
        assert(!Journal::save(Kind::Receive, hash, amount, false));
    for (uint8_t kind : {0, 4, 255})
        assert(!Journal::save(static_cast<Kind>(kind), hash, 1, false));
    assert(FakeNvs::state().writeOpens == 0 && FakeNvs::state().puts == 0);

    const char* alphabet = "AbZz019_-";
    for (size_t size = 16; size <= 64; ++size) {
        std::string id;
        for (size_t i = 0; i < size; ++i) id += alphabet[i % std::strlen(alphabet)];
        for (Kind kind : {Kind::Receive, Kind::Withdraw, Kind::SendToCard}) {
            for (bool dispatched : {false, true}) {
                FakeNvs::reset();
                assert(Journal::save(kind, id.c_str(), 1, dispatched));
                Journal::Record out{};
                assert(Journal::load(out) == Result::Valid);
                assert(out.kind == kind && out.dispatched == dispatched && out.amountSats == 1);
                assert(std::strcmp(out.reference, id.c_str()) == 0);
            }
        }
    }
}

static void validChecksumCannotAuthorizeInvalidFields() {
    FakeNvs::reset();
    assert(Journal::save(Kind::SendToCard, "12345678-AbCd_Efg", 1, false));
    const auto original = FakeNvs::active().bytes;
    const std::pair<size_t, uint8_t> bad[] = {
        {0, 'X'}, {4, 0}, {4, 255}, {5, 0}, {5, 4}, {5, 255}, {6, 2},
        {7, 0}, {7, 15}, {7, 65}, {8, 0}, {11, 128}, {15, 1},
        {16, '/'}, {16, 0x80}, {16, 0}, {33, 'x'}, {79, 'x'}};
    for (const auto& invalid : bad) {
        FakeNvs::active().bytes = original;
        FakeNvs::active().bytes[invalid.first] = invalid.second;
        checksum(FakeNvs::active().bytes);
        Journal::Record out{}; out.amountSats = 99;
        assert(Journal::load(out) == Result::Corrupt);
        assertEmpty(out);
    }
}

static void oneCheckoutCannotBeReplacedOrDowngraded() {
    FakeNvs::reset();
    assert(Journal::save(Kind::Receive, hash, 123, false));
    const auto original = FakeNvs::active().bytes;
    assert(Journal::save(Kind::Receive, hash, 123, false));
    assert(FakeNvs::state().puts == 1); // Repeated polls do not wear flash.
    assert(!Journal::save(Kind::Receive, "12345678-AbCd_Efg", 123, false));
    assert(!Journal::save(Kind::Withdraw, hash, 123, false));
    assert(!Journal::save(Kind::Receive, hash, 124, false));
    assert(FakeNvs::active().bytes == original);
    assert(Journal::save(Kind::Receive, hash, 123, true));
    const auto dispatched = FakeNvs::active().bytes;
    assert(Journal::save(Kind::Receive, hash, 123, true));
    assert(!Journal::save(Kind::Receive, hash, 123, false));
    assert(FakeNvs::active().bytes == dispatched);
    assert(FakeNvs::state().puts == 2 && FakeNvs::state().commits == 2);
    FakeNvs::active().bytes[0] ^= 1;
    const auto corrupt = FakeNvs::active().bytes;
    assert(!Journal::save(Kind::Withdraw, "12345678-AbCd_Efg", 1, false));
    assert(FakeNvs::active().bytes == corrupt);
    assert(FakeNvs::state().puts == 2 && FakeNvs::state().erases == 0);
}

static void terminalClearIsDurableAndNamespaceScoped() {
    FakeNvs::reset();
    FakeNvs::state().durable["bitpos"]["setting"].bytes = {1, 2, 3};
    assert(Journal::save(Kind::Withdraw, hash, 123, true));
    assert(Journal::clear()); // Caller has independently confirmed a terminal result.
    FakeNvs::reboot();
    Journal::Record out{}; out.amountSats = 99;
    assert(Journal::load(out) == Result::Missing);
    assertEmpty(out);
    assert((FakeNvs::state().durable["bitpos"]["setting"].bytes == std::vector<uint8_t>{1, 2, 3}));
    assert(Journal::clear()); // Idempotent without another erase/commit.
    assert(FakeNvs::state().erases == 1 && FakeNvs::state().commits == 2);
    assert(Journal::save(Kind::SendToCard, "12345678-AbCd_Efg", 1, false));
    assert(Journal::load(out) == Result::Valid && out.kind == Kind::SendToCard);
}

static void missingIsDistinctFromCorruptAndUnavailable() {
    FakeNvs::reset();
    Journal::Record out{}; out.amountSats = 99;
    assert(Journal::load(out) == Result::Missing);
    assertEmpty(out);
    assert(Journal::clear());
    assert(FakeNvs::state().durable.empty()); // Read-only boot must not create a namespace.
    FakeNvs::state().durable["ric-checkout"];
    assert(Journal::load(out) == Result::Missing); // Existing namespace, absent key.
    FakeNvs::active().blob = false;
    assert(Journal::load(out) == Result::Corrupt); // A wrong NVS type is not absence.
    FakeNvs::active().blob = true;
    assert(Journal::load(out) == Result::Corrupt); // A present, empty blob is not absence.
    assertEmpty(out);
    assert(FakeNvs::state().puts == 0 && FakeNvs::state().erases == 0);
}

static void readFailuresDoNotPermitWritesOrClears() {
    const std::vector<esp_err_t FakeNvs::State::*> errors = {
        &FakeNvs::State::openError, &FakeNvs::State::lengthError, &FakeNvs::State::readError};
    for (auto error : errors) {
        FakeNvs::reset();
        assert(Journal::save(Kind::SendToCard, hash, 123, true));
        const auto original = FakeNvs::active().bytes;
        FakeNvs::state().*error = ESP_FAIL;
        Journal::Record out{}; out.amountSats = 99;
        assert(Journal::load(out) == Result::Unavailable);
        assertEmpty(out);
        assert(!Journal::save(Kind::Receive, "12345678-AbCd_Efg", 123, false));
        assert(!Journal::clear());
        assert(FakeNvs::active().bytes == original);
        assert(FakeNvs::state().puts == 1 && FakeNvs::state().erases == 0);
        assert(FakeNvs::state().handles.empty());
        FakeNvs::state().*error = ESP_OK;
        assert(Journal::load(out) == Result::Valid);
    }
    FakeNvs::state().shortRead = true;
    Journal::Record out{}; out.amountSats = 99;
    assert(Journal::load(out) == Result::Unavailable);
    assertEmpty(out);
    assert(!Journal::save(Kind::SendToCard, hash, 123, true));
    assert(!Journal::clear());
    assert(FakeNvs::state().handles.empty());
}

static void failedDispatchBarrierReturnsFalse() {
    const std::vector<esp_err_t FakeNvs::State::*> errors = {
        &FakeNvs::State::setError, &FakeNvs::State::commitError};
    for (auto error : errors) {
        FakeNvs::reset();
        assert(Journal::save(Kind::Withdraw, hash, 123, false));
        const auto original = FakeNvs::active().bytes;
        FakeNvs::state().*error = ESP_FAIL;
        assert(!Journal::save(Kind::Withdraw, hash, 123, true));
        assert(FakeNvs::active().bytes == original);
        assert(FakeNvs::state().handles.empty());
        FakeNvs::reboot(); FakeNvs::state().*error = ESP_OK;
        Journal::Record out{};
        assert(Journal::load(out) == Result::Valid && !out.dispatched);
        assert(Journal::recoveryAction(Result::Valid) == Journal::RecoveryAction::Query);
    }
    FakeNvs::state().failWriteOpen = true;
    assert(!Journal::save(Kind::Withdraw, hash, 123, true));
    Journal::Record out{};
    assert(Journal::load(out) == Result::Valid && !out.dispatched);
    assert(FakeNvs::state().handles.empty());
    FakeNvs::reset(); FakeNvs::state().setError = ESP_FAIL;
    assert(!Journal::save(Kind::Withdraw, hash, 123, false));
    assert(Journal::load(out) == Result::Missing);
}

static void failedClearKeepsRecoveryBlocked() {
    const std::vector<esp_err_t FakeNvs::State::*> errors = {
        &FakeNvs::State::eraseError, &FakeNvs::State::commitError};
    for (auto error : errors) {
        FakeNvs::reset();
        assert(Journal::save(Kind::Receive, hash, 123, false));
        const auto original = FakeNvs::active().bytes;
        FakeNvs::state().*error = ESP_FAIL;
        assert(!Journal::clear());
        assert(FakeNvs::active().bytes == original);
        assert(FakeNvs::state().handles.empty());
        FakeNvs::reboot(); FakeNvs::state().*error = ESP_OK;
        Journal::Record out{};
        assert(Journal::load(out) == Result::Valid && !out.dispatched);
    }
    FakeNvs::state().failWriteOpen = true;
    assert(!Journal::clear());
    Journal::Record out{};
    assert(Journal::load(out) == Result::Valid);
    FakeNvs::state().failWriteOpen = false;
    FakeNvs::active().bytes[0] ^= 1;
    assert(Journal::load(out) == Result::Corrupt);
    assert(Journal::clear()); // Explicit operator resolution may clear an unreadable record.
    assert(Journal::load(out) == Result::Missing);
}

static void ambiguousCommitNeverAuthorizesDispatch() {
    FakeNvs::reset();
    assert(Journal::save(Kind::Withdraw, hash, 123, false));
    FakeNvs::state().commitError = ESP_FAIL;
    FakeNvs::state().commitOnError = true; // Commit reports failure AFTER bytes became durable.
    assert(!Journal::save(Kind::Withdraw, hash, 123, true));
    FakeNvs::reboot(); FakeNvs::state().commitError = ESP_OK;
    Journal::Record out{};
    assert(Journal::load(out) == Result::Valid && out.dispatched);
    assert(Journal::recoveryAction(Result::Valid) == Journal::RecoveryAction::Query);
    FakeNvs::state().commitError = ESP_FAIL;
    assert(!Journal::clear()); // Likewise, never claim success for an uncertain erase.
    FakeNvs::reboot(); FakeNvs::state().commitError = ESP_OK;
    assert(Journal::load(out) == Result::Missing);
}

static void fixedWireFormatContainsOnlyQueryMetadata() {
    FakeNvs::reset();
    const char reference[] = "A1b2C3d4E5f6G7h8\0PIN=654321 token=secret NFCsecret=secret BOLT11=lnbc";
    assert(Journal::save(Kind::SendToCard, reference, 0x01020304, true));
    const auto& bytes = FakeNvs::active().bytes;
    const uint8_t prefix[] = {0x52,0x49,0x43,0x4a,1,3,1,16,4,3,2,1,0,0,0,0};
    assert(bytes.size() == 84 && Journal::encodedSize == 84);
    assert(std::memcmp(bytes.data(), prefix, sizeof(prefix)) == 0);
    assert(std::memcmp(bytes.data() + 16, reference, 16) == 0);
    for (size_t i = 32; i < 80; ++i) assert(bytes[i] == 0);
    // Independently generated with Python struct.pack('<Q') and zlib.crc32.
    const uint8_t crc[] = {0x54,0x45,0x1b,0x5b};
    assert(std::memcmp(bytes.data() + 80, crc, sizeof(crc)) == 0);
    assert(FakeNvs::state().durable.size() == 1);
    assert(FakeNvs::state().durable["ric-checkout"].size() == 1);
}

int main() {
    restartRestoresQueryIdentity();
    corruptionNeverRestoresAnIdentity();
    inputValidationPrecedesFlashWrites();
    validChecksumCannotAuthorizeInvalidFields();
    oneCheckoutCannotBeReplacedOrDowngraded();
    terminalClearIsDurableAndNamespaceScoped();
    missingIsDistinctFromCorruptAndUnavailable();
    readFailuresDoNotPermitWritesOrClears();
    failedDispatchBarrierReturnsFalse();
    failedClearKeepsRecoveryBlocked();
    ambiguousCommitNeverAuthorizesDispatch();
    fixedWireFormatContainsOnlyQueryMetadata();
    std::puts("RIC journal: restart, corruption, validation, terminal clear, NVS faults and wire format pass");
}
