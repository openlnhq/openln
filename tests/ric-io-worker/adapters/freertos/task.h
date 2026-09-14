#pragma once
#include "FreeRTOS.h"
struct NativeTask;
using TaskHandle_t = NativeTask*;
using TaskFunction_t = void (*)(void*);
void vTaskDelete(TaskHandle_t task);
UBaseType_t uxTaskGetStackHighWaterMark(TaskHandle_t task);
#define tskNO_AFFINITY 0x7FFFFFFF
BaseType_t xTaskCreatePinnedToCore(TaskFunction_t work, const char* name,
  uint32_t stackBytes, void* context, UBaseType_t priority,
  TaskHandle_t* handle, BaseType_t core);
