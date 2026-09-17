#pragma once
#include <stdint.h>

// Classic ESP32-2432S028R CYD only. Do not import shared-bus S3 timing here.
namespace NfcPolicy {
// Keep v1.0.6's chip-side passive activation defaults and read recovery.
constexpr uint16_t kI2cTimeoutMs = 3000; // Preserve ISO-DEP clock stretching.
constexpr uint16_t kDetectTimeoutMs = 300;
constexpr uint8_t kNdefReadAttempts = 5; // Total attempts, as in v1.0.6.
}
