#include "host_freertos.h"
#include "esp_task_wdt.h"
#include "esp_system.h"
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <thread>
#include <utility>

struct NativeQueue {
  explicit NativeQueue(UBaseType_t size, UBaseType_t bytes)
    : length(size), itemSize(bytes), storage(size * bytes) {}
  UBaseType_t length;
  UBaseType_t itemSize;
  std::vector<unsigned char> storage;
  unsigned readAt = 0;
  unsigned writeAt = 0;
  unsigned count = 0;
  bool deleted = false;
  bool stopped = false;
  std::mutex mutex;
  std::condition_variable changed;
};
struct NativeTask { std::thread thread; };
namespace {
thread_local bool workerTask = false;
host::Runtime* current = nullptr;
struct StopTask {};
void require(bool condition) {
  if (!condition) { std::fputs("FreeRTOS adapter contract violated\n", stderr); std::abort(); }
}
void recordWait(TickType_t wait) {
  if (!workerTask && wait != 0) ++host::runtime().blockingUiCalls;
}
}
namespace host {
void Pause::stopHere() {
  std::unique_lock<std::mutex> lock(mutex);
  entered = true;
  changed.notify_all();
  changed.wait(lock, [&] { return released; });
}
bool Pause::waitForEntry() {
  std::unique_lock<std::mutex> lock(mutex);
  return changed.wait_for(lock, std::chrono::seconds(3), [&] { return entered; });
}
void Pause::release() {
  { std::lock_guard<std::mutex> lock(mutex); released = true; }
  changed.notify_all();
}
Runtime& runtime() { require(current != nullptr); return *current; }
bool onWorkerTask() { return workerTask; }
Runtime::Runtime() { require(current == nullptr); current = this; }
Runtime::~Runtime() {
  // Test-only scheduler teardown, AFTER callbacks finish. Not an I/O timeout.
  stopping = true;
  for (const auto& queue : queues) {
    { std::lock_guard<std::mutex> lock(queue->mutex); queue->stopped = true; }
    queue->changed.notify_all();
  }
  for (const auto& task : tasks) if (task->thread.joinable()) task->thread.join();
  current = nullptr;
}
std::vector<TaskSpec> Runtime::taskSpecs() {
  std::lock_guard<std::mutex> lock(resourcesMutex);
  return specs;
}
}
unsigned long millis() {
  auto& rt = host::runtime();
  if (rt.pauseNextMillis.exchange(false)) rt.inMillis.stopHere();
  return rt.clockMs.load();
}
esp_err_t esp_task_wdt_reset() {
  if (workerTask) ++host::runtime().workerWatchdogResets;
  else ++host::runtime().uiWatchdogResets;
  return ESP_OK;
}
esp_err_t esp_task_wdt_add(TaskHandle_t) { ++host::runtime().watchdogReconfigurations; return ESP_OK; }
esp_err_t esp_task_wdt_delete(TaskHandle_t) { ++host::runtime().watchdogReconfigurations; return ESP_OK; }
esp_err_t esp_task_wdt_init(uint32_t, bool) { ++host::runtime().watchdogReconfigurations; return ESP_OK; }
esp_err_t esp_task_wdt_deinit() { ++host::runtime().watchdogReconfigurations; return ESP_OK; }
void vTaskDelete(TaskHandle_t) { ++host::runtime().taskDeletes; }
UBaseType_t uxTaskGetStackHighWaterMark(TaskHandle_t task) {
  auto& rt = host::runtime();
  ++rt.watermarkQueries;
  if (!workerTask) ++rt.uiStackQueries;
  require(task == nullptr); // Worker should inspect its OWN stack, never the UI's.
  return rt.stackWatermarkBytes.load(); // ESP-IDF's unit is bytes, not words.
}
void esp_restart() { ++host::runtime().restarts; }
QueueHandle_t xQueueCreate(UBaseType_t length, UBaseType_t itemSize) {
  auto& rt = host::runtime();
  ++rt.queueCreates;
  rt.lastQueueLength = length;
  rt.lastQueueItemBytes = itemSize;
  if (rt.failQueueCreate.exchange(false)) return nullptr;
  require(length > 0 && itemSize > 0);
  std::unique_ptr<NativeQueue> queue(new NativeQueue(length, itemSize));
  auto* handle = queue.get();
  std::lock_guard<std::mutex> lock(rt.resourcesMutex);
  rt.queues.push_back(std::move(queue));
  ++rt.liveQueues;
  return handle;
}
void vQueueDelete(QueueHandle_t queue) {
  auto& rt = host::runtime();
  require(queue != nullptr);
  std::lock_guard<std::mutex> lock(queue->mutex);
  require(!queue->deleted && queue->count == 0);
  queue->deleted = true;
  ++rt.queueDeletes;
  --rt.liveQueues;
}
BaseType_t xQueueSend(QueueHandle_t queue, const void* item, TickType_t wait) {
  auto& rt = host::runtime();
  recordWait(wait);
  ++rt.sends;
  require(queue != nullptr && item != nullptr);
  if (rt.failSend.exchange(false)) return pdFALSE;
  std::unique_lock<std::mutex> lock(queue->mutex);
  require(!queue->deleted);
  if (queue->count == queue->length && wait != 0) {
    queue->changed.wait_for(lock, std::chrono::milliseconds(wait), [&] {
      return queue->count < queue->length || queue->stopped;
    });
  }
  if (queue->count == queue->length || queue->stopped) return pdFALSE;
  std::memcpy(queue->storage.data() + queue->writeAt * queue->itemSize, item, queue->itemSize);
  queue->writeAt = (queue->writeAt + 1) % queue->length;
  ++queue->count;
  lock.unlock();
  queue->changed.notify_one();
  if (rt.pauseNextSendReturn.exchange(false)) rt.beforeSendReturn.stopHere();
  return pdTRUE;
}
BaseType_t xQueueReceive(QueueHandle_t queue, void* item, TickType_t wait) {
  auto& rt = host::runtime();
  if (rt.pauseNextReceive.exchange(false)) rt.beforeReceive.stopHere();
  recordWait(wait);
  require(queue != nullptr && item != nullptr);
  std::unique_lock<std::mutex> lock(queue->mutex);
  require(!queue->deleted);
  if (queue->count == 0 && !queue->stopped && wait != 0) {
    ++rt.waitingReceivers;
    if (wait == portMAX_DELAY) {
      queue->changed.wait(lock, [&] { return queue->count > 0 || queue->stopped; });
    } else {
      queue->changed.wait_for(lock, std::chrono::milliseconds(wait), [&] {
        return queue->count > 0 || queue->stopped;
      });
    }
    --rt.waitingReceivers;
  }
  if (queue->stopped) { require(workerTask); throw StopTask{}; }
  if (queue->count == 0) return pdFALSE;
  std::memcpy(item, queue->storage.data() + queue->readAt * queue->itemSize, queue->itemSize);
  queue->readAt = (queue->readAt + 1) % queue->length;
  --queue->count;
  lock.unlock();
  queue->changed.notify_all();
  return pdTRUE;
}
BaseType_t xTaskCreatePinnedToCore(TaskFunction_t work, const char* name,
  uint32_t stackBytes, void* context, UBaseType_t priority,
  TaskHandle_t* handle, BaseType_t core) {
  auto& rt = host::runtime();
  ++rt.taskCreates;
  if (handle) *handle = nullptr;
  if (rt.pauseNextTaskCreate.exchange(false)) rt.inTaskCreate.stopHere();
  if (rt.failTaskCreate.exchange(false)) return errCOULD_NOT_ALLOCATE_REQUIRED_MEMORY;
  require(work != nullptr && name != nullptr && stackBytes != 0);
  require(priority < configMAX_PRIORITIES);
  require(core == tskNO_AFFINITY || (core >= 0 && core < portNUM_PROCESSORS));
  std::unique_ptr<NativeTask> task(new NativeTask);
  auto* raw = task.get();
  {
    std::lock_guard<std::mutex> lock(rt.resourcesMutex);
    rt.specs.push_back({name, stackBytes, priority, core});
    rt.tasks.push_back(std::move(task));
  }
  raw->thread = std::thread([work, context] {
    workerTask = true;
    try { work(context); } catch (const StopTask&) { return; }
    std::fputs("Persistent worker unexpectedly returned\n", stderr);
    std::abort();
  });
  if (handle) *handle = raw;
  return pdPASS;
}
