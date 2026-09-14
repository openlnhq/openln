#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace CardTransportPolicy {
// Pending includes every possibly dispatched request, not just HTTP 202.
// Only PinRejected is permission to correct a PIN on the same capability.
enum class Outcome : uint8_t {
    NotSubmitted, PinRejected, Rejected, Pending, Paid, Failed, Expired, Cancelled
};
constexpr size_t MaxUrlChars = 2047;
constexpr size_t MaxBodyBytes = 4096;
constexpr uint32_t ConnectTimeoutMs = 10000;
constexpr uint32_t HandshakeTimeoutSec = 10;
constexpr uint32_t BodyTimeoutMs = 8000;

inline bool hexDigit(char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
inline char lower(char c) { return c >= 'A' && c <= 'Z' ? char(c + ('a' - 'A')) : c; }
struct Origin { const char* host = nullptr; size_t hostLength = 0; uint16_t port = 443; };
// Match the ESP32 HTTPClient URL grammar, not a browser's permissive URL parser.
// No credentials, fragments, ambiguous authorities, controls, or decoded rewrites.
inline bool httpsUrl(const char* url, size_t n, Origin* out = nullptr) {
    if (!url || n < 9 || n > MaxUrlChars || strncmp(url, "https://", 8)) return false;
    for (size_t i = 0; i < n; ++i) {
        const unsigned char c = static_cast<unsigned char>(url[i]);
        if (c <= 32 || c >= 127 || c == '#' || c == '\\' || c == '"' || c == '<' || c == '>' || c == '`') return false;
        if (c == '%' && (i + 2 >= n || !hexDigit(url[i+1]) || !hexDigit(url[i+2]))) return false;
    }
    size_t end = 8;
    while (end < n && url[end] != '/' && url[end] != '?' && url[end] != ':') ++end;
    const size_t hostEnd = end;
    if (hostEnd == 8 || hostEnd - 8 > 253) return false;
    size_t label = 0;
    for (size_t i = 8; i < hostEnd; ++i) {
        const char c = lower(url[i]);
        if (c == '.') {
            if (!label || url[i-1] == '-') return false;
            label = 0;
        } else {
            if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') || (!label && c == '-') || ++label > 63) return false;
        }
    }
    if (!label || url[hostEnd-1] == '-') return false;
    uint32_t port = 443;
    if (end < n && url[end] == ':') {
        const size_t start = ++end;
        port = 0;
        while (end < n && url[end] >= '0' && url[end] <= '9') {
            port = port * 10 + unsigned(url[end++] - '0');
            if (port > 65535 || end - start > 5) return false;
        }
        if (!port || end == start) return false;
    }
    // HTTPClient requires a slash before a query; do not silently repair it.
    if (end < n && url[end] != '/') return false;
    if (out) { out->host = url + 8; out->hostLength = hostEnd - 8; out->port = uint16_t(port); }
    return true;
}
inline bool httpsUrl(const char* url, Origin* out = nullptr) {
    if (!url) return false;
    size_t n = 0; while (n <= MaxUrlChars && url[n]) ++n;
    return httpsUrl(url, n, out);
}
inline bool sameOrigin(const char* left, const char* right) {
    Origin a, b;
    if (!httpsUrl(left, &a) || !httpsUrl(right, &b) || a.port != b.port || a.hostLength != b.hostLength) return false;
    for (size_t i = 0; i < a.hostLength; ++i) if (lower(a.host[i]) != lower(b.host[i])) return false;
    return true;
}
}
