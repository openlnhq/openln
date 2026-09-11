#pragma once
#include <Arduino.h>

// CYD "SPEAK" 2-pin JST connector is driven by GPIO26 through an onboard
// transistor buffer. Supports BOTH active and passive buzzers:
//
// Active buzzer (e.g. TMB12A05): built-in oscillator — needs only HIGH/LOW.
// Passive buzzer (piezo transducer): no oscillator — needs PWM (square wave).
//
// The driver uses LEDC PWM on channel 1 (channel 0 is the backlight on GPIO21).
// For active buzzers, PWM at any frequency still produces the beep (the
// built-in oscillator dominates). For passive buzzers, PWM at 2.7kHz produces
// a clean audible tone. digitalWrite is NOT used — PWM is the universal path.
#define BUZZER_PIN  26
#define BUZZER_FREQ 2700   // Hz — clear audible tone for passive piezo
#define BUZZER_LEDC_CHANNEL LEDC_CHANNEL_1

class Buzzer {
public:
    static void init();

    static void playTap();
    static void playSuccess();
    static void playError();
    static void playBoot();

    static void startBeep();
    static void stopBeep();

    static void tick();

private:
    static const uint8_t MAX_SEG = 8;

    static uint16_t _seg[MAX_SEG];
    static uint8_t  _segCount;
    static uint8_t  _segIndex;
    static uint32_t _segStart;
    static bool     _active;

    // PWM on/off — controls the LEDC duty cycle
    static void on();
    static void off();

    static void start(const uint16_t* pattern, uint8_t len);
};
