#pragma once
#include <cstdint>
#include <deque>
#include <string>
#include <vector>

// Hardware-only seam: tests compile the production NfcReader.cpp unchanged.
// Match installed PN532 1.3.3 signatures, including its uint8_t read result.
namespace HostNfc {
struct Detection {
    bool found = true;
    std::vector<uint8_t> uid = {0x04, 0x01, 0x02, 0x03};
};
struct Read {
    uint8_t count = 0;
    std::string data;
};
struct State {
    bool devicePresent = true;
    bool beginOk = true;
    uint32_t firmware = 0x32010600;
    bool samOk = true;
    bool retriesOk = true;
    uint32_t now = 0;
    int sda = -1, scl = -1;
    uint16_t wireTimeout = 0;
    uint8_t address = 0;
    unsigned beginCalls = 0, samCalls = 0, readCalls = 0;
    std::vector<uint8_t> passiveRetries;
    std::vector<uint16_t> detectTimeouts;
    std::vector<int> readCapacities;
    std::vector<unsigned long> delays;
    std::vector<std::vector<uint8_t>> commands;
    std::vector<std::string> events;
    std::string serial;
    std::deque<Detection> detections;
    std::deque<Read> reads;
};
extern State state;
}
