#include "Buzzer.h"
#include "esp_timer.h"
#include "driver/ledc.h"

uint16_t Buzzer::_seg[Buzzer::MAX_SEG] = {0};
uint8_t  Buzzer::_segCount = 0;
uint8_t  Buzzer::_segIndex = 0;
uint32_t Buzzer::_segStart = 0;
bool     Buzzer::_active   = false;

static esp_timer_handle_t _timer = nullptr;
static portMUX_TYPE _mux = portMUX_INITIALIZER_UNLOCKED;

static void buzzerTimerCb(void*) { Buzzer::tick(); }

// ── PWM control ─────────────────────────────────────────────────────────────
// Uses LEDC channel 1 (channel 0 is backlight on GPIO21).
// 2.7kHz square wave at 50% duty cycle.

void Buzzer::on() {
    // 50% duty cycle — full volume on passive piezo
    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)BUZZER_LEDC_CHANNEL, 128);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)BUZZER_LEDC_CHANNEL);
}

void Buzzer::off() {
    ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)BUZZER_LEDC_CHANNEL, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)BUZZER_LEDC_CHANNEL);
}

void Buzzer::init() {
    // Configure LEDC PWM on GPIO26
    ledc_timer_config_t timer_conf = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_8_BIT,   // 0-255
        .timer_num = LEDC_TIMER_1,             // Timer 1 (timer 0 is backlight)
        .freq_hz = BUZZER_FREQ,                // 2.7kHz
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ledc_timer_config(&timer_conf);

    ledc_channel_config_t ch_conf = {
        .gpio_num = (gpio_num_t)BUZZER_PIN,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = BUZZER_LEDC_CHANNEL,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = LEDC_TIMER_1,
        .duty = 0,            // start OFF
        .hpoint = 0,
        .flags = { .output_invert = 0 },
    };
    ledc_channel_config(&ch_conf);

    _active = false;

    if (_timer == nullptr) {
        const esp_timer_create_args_t args = {
            .callback        = &buzzerTimerCb,
            .arg             = nullptr,
            .dispatch_method = ESP_TIMER_TASK,
            .name            = "buzzer",
            .skip_unhandled_events = true,
        };
        esp_timer_create(&args, &_timer);
        esp_timer_start_periodic(_timer, 5000);
    }
}

void Buzzer::start(const uint16_t* pattern, uint8_t len) {
    portENTER_CRITICAL(&_mux);
    _segCount = (len < MAX_SEG) ? len : MAX_SEG;
    for (uint8_t i = 0; i < _segCount; i++) _seg[i] = pattern[i];
    _segIndex = 0;
    _segStart = millis();
    _active   = true;
    portEXIT_CRITICAL(&_mux);
    // Index 0 is always an ON segment.
    on();
}

void Buzzer::playTap() {
    static const uint16_t p[] = {60};
    start(p, sizeof(p) / sizeof(p[0]));
}

void Buzzer::playSuccess() {
    static const uint16_t p[] = {60, 80, 60};
    start(p, sizeof(p) / sizeof(p[0]));
}

void Buzzer::playError() {
    static const uint16_t p[] = {500};
    start(p, sizeof(p) / sizeof(p[0]));
}

void Buzzer::playBoot() {
    static const uint16_t p[] = {80};
    start(p, sizeof(p) / sizeof(p[0]));
}

void Buzzer::startBeep() {
    portENTER_CRITICAL(&_mux);
    _active = false;
    portEXIT_CRITICAL(&_mux);
    on();
}

void Buzzer::stopBeep() {
    portENTER_CRITICAL(&_mux);
    _active = false;
    portEXIT_CRITICAL(&_mux);
    off();
}

void Buzzer::tick() {
    bool writePin = false;
    bool turnOn   = false;

    portENTER_CRITICAL(&_mux);
    if (_active && (millis() - _segStart >= _seg[_segIndex])) {
        _segIndex++;
        _segStart = millis();
        if (_segIndex >= _segCount) {
            _active  = false;
            writePin = true;
            turnOn   = false;
        } else {
            writePin = true;
            turnOn   = (_segIndex % 2 == 0);
        }
    }
    portEXIT_CRITICAL(&_mux);

    if (writePin) {
        if (turnOn) on();
        else off();
    }
}
