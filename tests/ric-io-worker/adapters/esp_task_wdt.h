#pragma once
#include "freertos/task.h"
using esp_err_t = int;
constexpr esp_err_t ESP_OK = 0;
esp_err_t esp_task_wdt_reset();
esp_err_t esp_task_wdt_add(TaskHandle_t task);
esp_err_t esp_task_wdt_delete(TaskHandle_t task);
esp_err_t esp_task_wdt_init(uint32_t seconds, bool panic);
esp_err_t esp_task_wdt_deinit();
