#include <nfc/NfcReader.h>
#include <HostNfc.h>
#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <string>

void require(bool ok, const char* message) {
    if (!ok) throw std::runtime_error(message);
}

void finitePassiveRetries() {
    require(NfcReader::begin(), "reader should initialize");
    const auto& s = HostNfc::state;
    require(s.passiveRetries == std::vector<uint8_t>{2},
            "begin must replace PN532's infinite passive retries with 0x02");
    require(s.sda == 22 && s.scl == 27, "classic CYD I2C pins must not change");
    require(NfcReader::getNfc().irq == 35 && NfcReader::getNfc().reset == 16,
            "classic CYD IRQ/RST pins must not change");
    require(s.wireTimeout == 3000, "preserve real 3-second I2C clock-stretch budget");
    auto sam = std::find(s.events.begin(), s.events.end(), "sam");
    auto retries = std::find(s.events.begin(), s.events.end(), "passive-retries:2");
    require(sam < retries, "set finite retries after SAM configuration");
    HostNfc::state.detections.push_back({});
    String uid;
    require(NfcReader::detectCard(uid), "valid card detection should work");
    require(s.detectTimeouts == std::vector<uint16_t>{300}, "retain 300ms detection wait parameter");
}

void initializationFailsClosed(const std::string& stage) {
    if (stage == "failed-rebegin") require(NfcReader::begin(), "initial begin should succeed");
    auto& s = HostNfc::state;
    if (stage == "begin-failure") s.beginOk = false;
    else if (stage == "sam-failure") s.samOk = false;
    else s.retriesOk = false;
    require(!NfcReader::begin(), "failed PN532 initialization must not mark reader ready");
    s.detections.push_back({});
    String uid;
    require(!NfcReader::detectCard(uid), "must not poll with missing finite-retry configuration");
    require(s.detectTimeouts.empty(), "failed init must prevent library detection calls");
    require(NfcReader::readNdef().isEmpty(), "failed init must not read a previous card");
    s.beginOk = true; s.samOk = true; s.retriesOk = true;
    require(NfcReader::reinit(), "healthy hardware should recover on reinit");
    require(NfcReader::detectCard(uid), "detection should resume after successful reinit");
}

void activateCard() {
    require(NfcReader::begin(), "reader should initialize");
    HostNfc::state.detections.push_back({});
    String uid;
    require(NfcReader::detectCard(uid), "initial detection should work");
}

void twoReadAttempts() {
    activateCard();
    auto& s = HostNfc::state;
    // Enough failing fixtures to expose the old five-attempt loop.
    for (int i = 0; i < 5; ++i) { s.reads.push_back({}); s.detections.push_back({}); }
    require(NfcReader::readNdef().isEmpty(), "exhausted reads must fail");
    require(s.readCalls == 2, "a single tap must perform at most two NDEF read attempts, not five");
    require(s.commands == std::vector<std::vector<uint8_t>>{{0x32, 0x01, 0x00}, {0x32, 0x01, 0x01}},
            "only one existing RF-off/on recovery is allowed");
    require(s.detectTimeouts == std::vector<uint16_t>{300, 1000}, "keep established reactivation timeout");
    require(s.delays == std::vector<unsigned long>{250, 50, 100, 300}, "preserve RF/activation settling");
    require(s.samCalls == 2, "read failure must still clean up the active target");
    require(s.serial.find("after 2 attempts") != std::string::npos, "log actual number of read attempts");
    require(NfcReader::readNdef().isEmpty() && s.readCalls == 2, "a new read requires fresh card detection");
}

void recoveryRead(const std::string& test) {
    activateCard();
    auto& s = HostNfc::state;
    const std::string url = "lnurlw://example.test/card/test?p=fixture&c=fixture";
    if (test != "first-attempt-success") {
        s.reads.push_back({});
        s.detections.push_back({test != "card-removed", {0x04, 0x01, 0x02, 0x03}});
    }
    s.reads.push_back({static_cast<uint8_t>(url.size()), url});
    const auto result = NfcReader::readNdef();
    if (test == "card-removed") {
        require(result.isEmpty() && s.readCalls == 1, "card removal must prevent a second read");
        require(s.serial.find("after 1 attempts") != std::string::npos, "card removal must log the actual attempt count");
    } else {
        require(std::string(result.c_str()) == "https://example.test/card/test?p=fixture&c=fixture",
                "read must preserve URL and scheme normalization");
        require(s.readCalls == (test == "first-attempt-success" ? 1u : 2u), "stop reading immediately on success");
    }
    require(s.samCalls == 2, "cleanup must run after a read, successful or not");
}

void invalidUid(unsigned count, bool retry) {
    if (retry) activateCard();
    else require(NfcReader::begin(), "reader should initialize");
    auto& s = HostNfc::state;
    s.detections.push_back({true, std::vector<uint8_t>(count, 0x04)});
    if (retry) {
        s.reads.push_back({});
        const std::string url = "https://example.test/card/never-read";
        s.reads.push_back({static_cast<uint8_t>(url.size()), url});
        require(NfcReader::readNdef().isEmpty(), "invalid reactivated UID must stop the retry");
        require(s.readCalls == 1, "do not read NDEF after invalid reactivation");
    } else {
        String uid = "stale-uid";
        require(!NfcReader::detectCard(uid), "invalid UID length must be rejected before exposure");
        require(uid.isEmpty(), "failed detection must not leave a stale output UID");
        require(NfcReader::readNdef().isEmpty() && s.readCalls == 0, "invalid UID must not arm NDEF reads");
    }
}

void validUid(unsigned count) {
    require(NfcReader::begin(), "reader should initialize");
    auto& s = HostNfc::state;
    s.detections.push_back({true, std::vector<uint8_t>(count, 0x04)});
    String uid;
    require(NfcReader::detectCard(uid), "privacy and factory UID lengths must remain supported");
    require(uid.length() == count * 2, "valid UID must be hex-encoded at full length");
    s.detections.push_back({false, {}});
    require(!NfcReader::detectCard(uid), "no card should fail detection");
    require(uid.isEmpty(), "failed detection must clear the preceding card's UID");
    require(NfcReader::readNdef().isEmpty() && s.readCalls == 0, "no card means no NDEF read");
}

void privateNdefLogging() {
    activateCard();
    auto& s = HostNfc::state;
    const std::string url = "lnurlw://example.test/SECRET_PATH?p=SECRET_PICC&c=SECRET_CMAC";
    s.reads.push_back({static_cast<uint8_t>(url.size()), url});
    const auto result = NfcReader::readNdef();
    require(std::string(result.c_str()) == "https://example.test/SECRET_PATH?p=SECRET_PICC&c=SECRET_CMAC",
            "private NDEF data must still be returned to the caller");
    require(s.serial.find("SECRET_") == std::string::npos && s.serial.find("example.test") == std::string::npos,
            "never log a raw, partial, or normalized NDEF URL");
}

int main(int argc, char** argv) {
    try {
        if (argc != 2) throw std::runtime_error("one named test is required");
        const std::string test = argv[1];
        if (test == "finite-passive-retries") finitePassiveRetries();
        else if (test == "begin-failure" || test == "sam-failure" ||
                 test == "retry-config-failure" || test == "failed-rebegin") initializationFailsClosed(test);
        else if (test == "two-read-attempts") twoReadAttempts();
        else if (test == "first-attempt-success" || test == "second-attempt-success" || test == "card-removed") recoveryRead(test);
        else if (test.rfind("invalid-uid-", 0) == 0) invalidUid(std::stoul(test.substr(12)), false);
        else if (test.rfind("retry-uid-", 0) == 0) invalidUid(std::stoul(test.substr(10)), true);
        else if (test.rfind("valid-uid-", 0) == 0) validUid(std::stoul(test.substr(10)));
        else if (test == "private-ndef-logging") privateNdefLogging();
        else throw std::runtime_error("unknown test: " + test);
        std::cout << "PASS " << test << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL " << (argc > 1 ? argv[1] : "test") << ": " << error.what() << '\n';
        return 1;
    }
}
