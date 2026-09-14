#include <Adafruit_PN532_NTAG424.h>
#include <stdexcept>

HostNfc::State HostNfc::state;
HostSerial Serial;
TwoWire Wire;

bool Adafruit_PN532::begin() {
    ++HostNfc::state.beginCalls;
    HostNfc::state.events.push_back("begin");
    return HostNfc::state.beginOk;
}
uint32_t Adafruit_PN532::getFirmwareVersion() { return HostNfc::state.firmware; }
bool Adafruit_PN532::SAMConfig() {
    ++HostNfc::state.samCalls;
    HostNfc::state.events.push_back("sam");
    return HostNfc::state.samOk;
}
bool Adafruit_PN532::setPassiveActivationRetries(uint8_t retries) {
    HostNfc::state.passiveRetries.push_back(retries);
    HostNfc::state.events.push_back("passive-retries:" + std::to_string(retries));
    return HostNfc::state.retriesOk;
}
bool Adafruit_PN532::readPassiveTargetID(uint8_t, uint8_t* uid, uint8_t* count, uint16_t timeout) {
    HostNfc::state.detectTimeouts.push_back(timeout);
    HostNfc::state.events.push_back("detect:" + std::to_string(timeout));
    if (HostNfc::state.detections.empty()) return false;
    const auto found = HostNfc::state.detections.front();
    HostNfc::state.detections.pop_front();
    if (!found.found) return false;
    if (found.uid.size() > UINT8_MAX) throw std::runtime_error("invalid test fixture UID");
    *count = static_cast<uint8_t>(found.uid.size());
    // Deliberately reproduce 1.3.3's unchecked caller-buffer copy.
    if (*count) std::memcpy(uid, found.uid.data(), *count);
    return true;
}
bool Adafruit_PN532::sendCommandCheckAck(uint8_t* cmd, uint8_t count, uint16_t) {
    HostNfc::state.commands.emplace_back(cmd, cmd + count);
    HostNfc::state.events.push_back("command:" + std::to_string(cmd[0]));
    return true;
}
uint8_t Adafruit_PN532::ntag424_ISOReadFile(uint8_t* buffer, int maxsize) {
    ++HostNfc::state.readCalls;
    HostNfc::state.readCapacities.push_back(maxsize);
    HostNfc::state.events.push_back("read");
    if (HostNfc::state.reads.empty()) return 0;
    const auto read = HostNfc::state.reads.front();
    HostNfc::state.reads.pop_front();
    if (read.data.size() > static_cast<size_t>(maxsize))
        throw std::runtime_error("invalid test fixture read size");
    if (!read.data.empty()) std::memcpy(buffer, read.data.data(), read.data.size());
    return read.count;
}
