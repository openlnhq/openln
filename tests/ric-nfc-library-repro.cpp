// Read-only reproduction of the INSTALLED library, not a copied implementation.
// The runner extracts these real method bodies verbatim into installed-methods.inc.
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <deque>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
#include "installed-constants.inc"

#define F(s) s
#define HEX 16
#define PN532DEBUGPRINT Serial
struct NullSerial {
    template<class... T> void print(T...) {}
    template<class... T> void println(T...) {}
} Serial;
uint8_t pn532_packetbuffer[PN532_PACKBUFFSIZ] = {};
static_assert(PN532_PACKBUFFSIZ == 64, "Do not hide upstream overreads with a larger test buffer");
using Frame = std::array<uint8_t, PN532_PACKBUFFSIZ>;
std::deque<Frame> responses;
std::vector<std::vector<uint8_t>> commands;
bool transportFailure = false;
size_t transportLimit = 64;
uint8_t readyByte = 1;

Frame popFrame() {
    if (responses.empty()) throw std::runtime_error("response fixture exhausted");
    const auto frame = responses.front(); responses.pop_front();
    return frame;
}
struct FakeI2C {
    bool read(uint8_t* buffer, size_t size) {
        const auto frame = popFrame();
        buffer[0] = readyByte;
        std::memcpy(buffer + 1, frame.data(), std::min(size - 1, transportLimit));
        return !transportFailure && size - 1 <= transportLimit;
    }
} i2c;
struct FakeSPI {
    bool write_then_read(uint8_t*, size_t, uint8_t* buffer, size_t size) {
        const auto frame = popFrame();
        std::memcpy(buffer, frame.data(), std::min(size, transportLimit));
        return !transportFailure && size <= transportLimit;
    }
} spi;
struct FakeUART {
    size_t readBytes(uint8_t* buffer, size_t size) {
        const auto frame = popFrame();
        const size_t count = std::min(size, transportLimit);
        std::memcpy(buffer, frame.data(), count);
        return count;
    }
} uart;

class Adafruit_PN532 {
public:
    FakeI2C* i2c_dev = &i2c;
    FakeSPI* spi_dev = nullptr;
    FakeUART* ser_dev = nullptr;
    uint8_t _inListedTag = 1;
    bool setPassiveActivationRetries(uint8_t maxRetries);
    bool readDetectedPassiveTargetID(uint8_t* uid, uint8_t* uidLength);
    uint8_t ntag424_ISOReadFile(uint8_t* buffer, int maxsize);
    bool inDataExchange(uint8_t*, uint8_t, uint8_t*, uint8_t*);
    bool waitready(uint16_t) { return true; }
    bool sendCommandCheckAck(uint8_t* cmd, uint8_t size, uint16_t = 100) {
        commands.emplace_back(cmd, cmd + size);
        return true;
    }
    void readdata(uint8_t* buffer, uint8_t size);
};
#include "installed-methods.inc"

void require(bool ok, const std::string& why) {
    if (!ok) throw std::runtime_error(why);
}

Frame exchangeFrame(const std::vector<uint8_t>& payload) {
    Frame frame{};
    frame[2] = 0xff;
    frame[3] = payload.size() + 3;
    frame[4] = uint8_t(-frame[3]);
    frame[5] = 0xd5; frame[6] = 0x41; // InDataExchange response, status zero.
    std::copy(payload.begin(), payload.end(), frame.begin() + 8);
    unsigned sum = 0;
    for (unsigned i = 5; i < 5u + frame[3]; ++i) sum += frame[i];
    frame[5 + frame[3]] = uint8_t(-sum);
    return frame;
}

void queueNdef(uint16_t nlen, const std::string& uri) {
    responses.push_back(exchangeFrame({0x91, 0xae})); // Unauthenticated metadata is optional.
    responses.push_back(exchangeFrame({0x90, 0x00})); // select AID
    responses.push_back(exchangeFrame({0x90, 0x00})); // select EF
    responses.push_back(exchangeFrame({uint8_t(nlen >> 8), uint8_t(nlen), 0xd1,
        0x01, uint8_t(uri.size() + 1), 0x55, 0x00, 0x90, 0x00}));
    // Supply fixed bounded pages; the original code chooses the copy length.
    for (size_t offset = 0; offset <= 256; offset += 32) {
        const size_t remaining = offset < uri.size() ? uri.size() - offset : 0;
        std::vector<uint8_t> payload(std::min(size_t(32), remaining), 'x');
        for (size_t i = 0; i < payload.size(); ++i) payload[i] = uri[offset + i];
        payload.push_back(0x90); payload.push_back(0x00);
        responses.push_back(exchangeFrame(payload));
    }
}

void queueUid(uint8_t length) {
    Frame frame{};
    frame[2] = 0xff; frame[3] = 15; frame[4] = uint8_t(-frame[3]);
    frame[5] = 0xd5; frame[6] = 0x4b; frame[7] = 1; frame[8] = 1;
    frame[12] = length;
    std::fill(frame.begin() + 13, frame.begin() + 20, 0x04);
    unsigned sum = 0;
    for (unsigned i = 5; i < 20; ++i) sum += frame[i];
    frame[20] = uint8_t(-sum);
    responses.push_back(frame);
}

int main(int argc, char** argv) {
    try {
        if (argc != 2) throw std::runtime_error("one named probe required");
        Adafruit_PN532 nfc;
        const std::string test = argv[1];
        if (test == "finite-command") {
            require(nfc.setPassiveActivationRetries(2), "finite retry command failed");
            require(commands == std::vector<std::vector<uint8_t>>{{0x32, 5, 0xff, 0x01, 0x02}},
                    "library must send documented MaxRetries field without changing ATR/PSL defaults");
        } else if (test == "valid-ndef") {
            const std::string url = "https://example.test/card/test?p=fixture&c=fixture";
            queueNdef(url.size() + 5, url);
            uint8_t buffer[512] = {};
            const auto size = nfc.ntag424_ISOReadFile(buffer, sizeof(buffer) - 1);
            require(size == url.size() && std::memcmp(buffer, url.data(), size) == 0, "valid short URI control");
        } else if (test == "ndef-small-buffer" || test == "ndef-short-header" || test == "ndef-short-page") {
            const std::string url = "lnurlw://example.test/card/test?p=fixture&c=fixture";
            queueNdef(url.size() + 5, url);
            if (test == "ndef-short-header") responses[3] = exchangeFrame({0, uint8_t(url.size() + 5), 0xd1, 0x90, 0});
            if (test == "ndef-short-page") responses[4] = exchangeFrame({'x', 0x90, 0});
            uint8_t buffer[512] = {};
            const auto size = nfc.ntag424_ISOReadFile(buffer, test == "ndef-small-buffer" ? 3 : 511);
            require(size == 0, "truncated URL or header/page must not be returned as success");
        } else if (test == "nlen-zero" || test == "nlen-high-byte") {
            queueNdef(test == "nlen-zero" ? 0 : 0x0112, "https://example.test/invalid");
            uint8_t buffer[512] = {};
            const auto size = nfc.ntag424_ISOReadFile(buffer, sizeof(buffer) - 1);
            require(size == 0, "invalid NTAG424 NLEN must be rejected, returned " + std::to_string(size));
        } else if (test == "read-failed-i2c" || test == "read-failed-spi" || test == "read-short-uart") {
            Frame frame{}; frame.fill(0x42); responses.push_back(frame);
            uint8_t output[8]; std::memset(output, 0xa5, sizeof(output));
            transportFailure = true;
            if (test == "read-failed-spi") { nfc.i2c_dev = nullptr; nfc.spi_dev = &spi; }
            if (test == "read-short-uart") { nfc.i2c_dev = nullptr; nfc.ser_dev = &uart; transportLimit = 4; }
            nfc.readdata(output, sizeof(output));
            require(std::all_of(std::begin(output), std::end(output), [](uint8_t v) { return v == 0; }),
                    "failed or partial bus read must invalidate all returned bytes");
        } else if (test == "exchange-short-frame" || test == "exchange-long-frame" || test == "exchange-checksum" || test == "exchange-small-buffer") {
            auto frame = exchangeFrame({0x90, 0});
            if (test == "exchange-short-frame") { frame[3] = 2; frame[4] = uint8_t(-2); }
            if (test == "exchange-long-frame") { frame[3] = 255; frame[4] = 1; }
            if (test == "exchange-checksum") frame[5 + frame[3]] ^= 0x40;
            responses.push_back(frame);
            uint8_t send[1] = {0xa4}, result[255] = {}, size = test == "exchange-small-buffer" ? 1 : 255;
            require(!nfc.inDataExchange(send, 1, result, &size), "corrupt/truncated APDU must fail");
        } else if (test == "valid-uid") {
            queueUid(7);
            uint8_t uid[7] = {}, size = 0;
            require(nfc.readDetectedPassiveTargetID(uid, &size) && size == 7, "valid UID must be preserved");
        } else if (test == "uid-destination-capacity") {
            struct Guarded { uint8_t uid[7]; uint8_t guard[8]; } buffer{};
            std::fill(std::begin(buffer.guard), std::end(buffer.guard), 0xa5);
            queueUid(8);
            uint8_t size = 0;
            const bool found = nfc.readDetectedPassiveTargetID(buffer.uid, &size);
            require(std::all_of(std::begin(buffer.guard), std::end(buffer.guard), [](uint8_t b) { return b == 0xa5; }),
                    "UID length 8 overwrote documented 7-byte caller capacity");
            require(!found, "invalid UID length must fail detection");
        } else if (test == "uid-library-source-capacity") {
            // A large caller scratch buffer cannot protect the library's own 64-byte packet source.
            uint8_t uid[UINT8_MAX] = {}, size = 0;
            queueUid(UINT8_MAX);
            require(!nfc.readDetectedPassiveTargetID(uid, &size), "oversize UID must be rejected before copying");
        } else throw std::runtime_error("unknown probe");
        std::cout << "PASS " << test << '\n';
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL " << argv[1] << ": " << e.what() << '\n';
        return 1;
    }
}
