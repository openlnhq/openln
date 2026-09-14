#pragma once
#include "Arduino.h"
inline void esp_task_wdt_init(int,bool){}
inline void esp_task_wdt_add(void*){}
inline void esp_task_wdt_reset(){++RicMainShim::watchdogFeeds;}
