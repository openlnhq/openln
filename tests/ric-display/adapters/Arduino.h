#pragma once
// Host-only Arduino boundary. Never included in a PlatformIO firmware build.
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iomanip>
#include <sstream>
#include <string>
#include <type_traits>
#include <vector>

#define PROGMEM
#define F(x) x
using byte = uint8_t;
using boolean = bool;
using std::min;
using std::max;
using std::abs;

class String {
    std::string value_;
public:
    String() = default;
    String(const char* value) : value_(value ? value : "") {}
    String(const std::string& value) : value_(value) {}
    String(char value) : value_(1, value) {}
    template<class T, std::enable_if_t<std::is_integral_v<T> && !std::is_same_v<T, char>, int> = 0>
    String(T value) : value_(std::to_string(value)) {}
    String(double value, unsigned char places = 2) {
        std::ostringstream stream;
        stream << std::fixed << std::setprecision(places) << value;
        value_ = stream.str();
    }
    unsigned int length() const { return value_.size(); }
    bool isEmpty() const { return value_.empty(); }
    bool reserve(unsigned int capacity) { value_.reserve(capacity); return true; }
    const char* c_str() const { return value_.c_str(); }
    char operator[](unsigned int i) const { return i < value_.size() ? value_[i] : 0; }
    char charAt(unsigned int i) const { return (*this)[i]; }
    String& operator+=(const String& rhs) { value_ += rhs.value_; return *this; }
    String& operator+=(char rhs) { value_ += rhs; return *this; }
    friend String operator+(String lhs, const String& rhs) { lhs += rhs; return lhs; }
    friend bool operator==(const String& lhs, const String& rhs) { return lhs.value_ == rhs.value_; }
    friend bool operator!=(const String& lhs, const String& rhs) { return !(lhs == rhs); }
    void remove(unsigned int index, unsigned int count = ~0U) {
        if (index < value_.size()) value_.erase(index, count);
    }
    String substring(unsigned int from, unsigned int to = ~0U) const {
        if (from > to) std::swap(from, to);
        from = std::min<unsigned int>(from, value_.size());
        to = std::min<unsigned int>(to, value_.size());
        return value_.substr(from, to - from);
    }
    void toUpperCase() { for (char& ch : value_) ch = std::toupper(static_cast<unsigned char>(ch)); }
    void toLowerCase() { for (char& ch : value_) ch = std::tolower(static_cast<unsigned char>(ch)); }
    void toCharArray(char* buffer, unsigned int size) const {
        if (size) { std::strncpy(buffer, value_.c_str(), size - 1); buffer[size - 1] = 0; }
    }
    int indexOf(char needle, unsigned int from = 0) const {
        auto found = value_.find(needle, from); return found == std::string::npos ? -1 : found;
    }
    int indexOf(const String& needle, unsigned int from = 0) const {
        auto found = value_.find(needle.value_, from); return found == std::string::npos ? -1 : found;
    }
    bool startsWith(const String& prefix) const { return value_.rfind(prefix.value_, 0) == 0; }
    bool endsWith(const String& suffix) const {
        return value_.size() >= suffix.value_.size() &&
            value_.compare(value_.size() - suffix.value_.size(), suffix.value_.size(), suffix.value_) == 0;
    }
    long toInt() const { return std::strtol(value_.c_str(), nullptr, 10); }
};

namespace host {
extern uint32_t nowMs;
extern std::vector<uint32_t> delays;
void resetClock(uint32_t now);
}
// uint32_t is intentional. Linux unsigned long would conceal ESP32 rollover.
inline uint32_t millis() { return host::nowMs; }
void delay(uint32_t milliseconds);
inline void yield() {}
