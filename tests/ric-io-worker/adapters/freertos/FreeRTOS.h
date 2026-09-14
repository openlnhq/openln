#pragma once
#include <cstdint>
using BaseType_t = int;
using UBaseType_t = unsigned int;
using TickType_t = uint32_t;
constexpr BaseType_t pdFALSE = 0;
constexpr BaseType_t pdTRUE = 1;
constexpr BaseType_t pdPASS = pdTRUE;
constexpr BaseType_t errCOULD_NOT_ALLOCATE_REQUIRED_MEMORY = -1;
constexpr TickType_t portMAX_DELAY = UINT32_MAX;
#define configMAX_PRIORITIES 25
#define portNUM_PROCESSORS 2
