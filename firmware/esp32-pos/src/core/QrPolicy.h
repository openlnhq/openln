#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>
namespace RicQr {
// ISO QR alphanumeric capacities, ECC_LOW, versions 1..20. Derived from
// ricmoo/QRCode 0.0.1 NUM_RAW_DATA_MODULES and error-correction codewords.
// That encoder has no overflow rejection. Never probe too-small versions.
inline uint8_t versionForAlphaLength(size_t length) {
    static const uint16_t capacities[] = {
        25,47,77,114,154,195,224,279,335,395,
        468,535,619,667,758,854,938,1046,1153,1249
    };
    if (!length) return 0;
    for (uint8_t i=0;i<20;++i) if (length<=capacities[i]) return i+1;
    return 0;
}
inline bool isAlphanumeric(const char* text) {
    if (!text || !*text) return false;
    for (;*text;++text) {
        if ((*text>='0' && *text<='9') || (*text>='A' && *text<='Z')) continue;
        if (!std::strchr(" $%*+-./:",*text)) return false;
    }
    return true;
}
}
