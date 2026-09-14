#pragma once
#include "FreeRTOS.h"
struct NativeQueue;
using QueueHandle_t = NativeQueue*;
QueueHandle_t xQueueCreate(UBaseType_t length, UBaseType_t itemSize);
BaseType_t xQueueSend(QueueHandle_t queue, const void* item, TickType_t wait);
BaseType_t xQueueReceive(QueueHandle_t queue, void* item, TickType_t wait);
void vQueueDelete(QueueHandle_t queue);
