#pragma once
#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include "HostNfc.h"

constexpr int LOW = 0;
constexpr int HEX = 16;
class String {
    std::string value;
public:
    String() = default;
    String(const char* s) : value(s ? s : "") {}
    String(const std::string& s) : value(s) {}
    String(unsigned char n, int base) {
        char s[16];
        std::snprintf(s, sizeof(s), base == HEX ? "%x" : "%u", unsigned(n));
        value = s;
    }
    bool isEmpty() const { return value.empty(); }
    unsigned int length() const { return value.size(); }
    const char* c_str() const { return value.c_str(); }
    char charAt(unsigned int i) const { return i < value.size() ? value[i] : 0; }
    bool startsWith(const char* prefix) const { return value.rfind(prefix, 0) == 0; }
    String substring(unsigned int start) const {
        return start < value.size() ? String(value.substr(start)) : String();
    }
    String substring(unsigned int start, unsigned int end) const {
        if (end < start) std::swap(start, end);
        return start < value.size() ? String(value.substr(start, end - start)) : String();
    }
    String& operator+=(char c) { value += c; return *this; }
    String& operator+=(const String& s) { value += s.value; return *this; }
    friend String operator+(const char* left, const String& right) {
        return String(std::string(left) + right.value);
    }
};
class HostSerial {
public:
    void println(const char* s) { HostNfc::state.serial += std::string(s) + "\n"; }
    void printf(const char* fmt, ...) {
        char out[2048];
        va_list args;
        va_start(args, fmt);
        std::vsnprintf(out, sizeof(out), fmt, args);
        va_end(args);
        HostNfc::state.serial += out;
    }
};
extern HostSerial Serial;
inline unsigned long millis() { return HostNfc::state.now; }
inline void delay(unsigned long ms) {
    HostNfc::state.now += ms;
    HostNfc::state.delays.push_back(ms);
    HostNfc::state.events.push_back("delay:" + std::to_string(ms));
}
inline int digitalRead(int) { return LOW; }
