#pragma once
#include <stdint.h>

// Classic ESP32-2432S028R CYD only. Do not import shared-bus S3 timing here.
namespace NfcPolicy {
// PN532 User Manual UM0701-02, RFConfiguration CfgItem 0x05:
// MxRtyPassiveActivation defaults to 0xFF (forever); 0 means one try.
// Two retries bounds chip-side discovery independently of the host wait.
constexpr uint8_t kPassiveActivationRetries = 0x02;
constexpr uint16_t kI2cTimeoutMs = 3000; // Preserve ISO-DEP clock stretching.
constexpr uint16_t kDetectTimeoutMs = 300;
constexpr uint8_t kNdefReadAttempts = 2; // Total attempts, not two extra retries.
}
