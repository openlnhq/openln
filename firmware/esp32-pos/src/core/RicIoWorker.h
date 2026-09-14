#pragma once

#include <Arduino.h>
#include <atomic>
#include <cstdint>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <freertos/task.h>

// One persistent task, one borrowed context. The worker does not allocate per
// operation (the callback may). These are task-context APIs, not ISR APIs.
// Create at static/firmware lifetime. There is intentionally no stop/cancel:
// deleting a task cannot establish whether an in-flight payment was sent.
// The context and any objects it references must remain alive and untouched
// from an accepted start() until the single result owner succeeds at take().
// Work runs synchronously ON THE WORKER, never on the submitting/UI task.
// Work must return normally and may not touch display/touch/UI hardware.
// Blocking I/O must yield/use bounded transport timeouts; a CPU-spinning
// callback can still starve its core's idle task. No watchdog is reset here.
class RicIoWorker {
 public:
  using Work = void (*)(void*);
  enum class Stage : uint32_t {
    Unavailable, Starting, Idle, Submitting, Queued, Running, Ready
  };

  RicIoWorker() = default;
  RicIoWorker(const RicIoWorker&) = delete;
  RicIoWorker& operator=(const RicIoWorker&) = delete;
  RicIoWorker(RicIoWorker&&) = delete;
  RicIoWorker& operator=(RicIoWorker&&) = delete;

  // Setup only. ESP-IDF task stack sizes are BYTES, not StackType_t words.
  bool begin(const char* name = "ric-io", uint32_t stackBytes = 16384,
             BaseType_t core = 0, UBaseType_t priority = 1) {
    Stage expected = Stage::Unavailable;
    if (!_stage.compare_exchange_strong(expected, Stage::Starting,
                                        std::memory_order_acq_rel,
                                        std::memory_order_acquire)) {
      // A completed begin is idempotent; a competing initializer never waits.
      return expected != Stage::Starting;
    }
    if (!name || !*name || stackBytes == 0 || priority >= configMAX_PRIORITIES ||
        (core != tskNO_AFFINITY && (core < 0 || core >= portNUM_PROCESSORS))) {
      _stage.store(Stage::Unavailable, std::memory_order_release);
      return false;
    }
    _jobs = xQueueCreate(1, sizeof(Job));
    if (!_jobs) {
      _stage.store(Stage::Unavailable, std::memory_order_release);
      return false;
    }
    if (xTaskCreatePinnedToCore(taskEntry, name, stackBytes, this, priority,
                                nullptr, core) != pdPASS) {
      vQueueDelete(_jobs);
      _jobs = nullptr;
      _stage.store(Stage::Unavailable, std::memory_order_release);
      return false;
    }
    _stage.store(Stage::Idle, std::memory_order_release);
    return true;
  }

  // One atomic claim, one zero-tick queue send, no retry/wait loop. FreeRTOS
  // still uses short internal critical sections: not a formal wait-free claim.
  bool start(Work work, void* context) {
    Stage expected = Stage::Idle;
    if (!work || !_stage.compare_exchange_strong(expected, Stage::Submitting,
                                                 std::memory_order_acq_rel,
                                                 std::memory_order_acquire)) return false;
    const uint32_t previousStart = _startedAt.load(std::memory_order_relaxed);
    _startedAt.store(static_cast<uint32_t>(millis()), std::memory_order_relaxed);
    _stage.store(Stage::Queued, std::memory_order_release);
    const Job job{work, context};
    if (xQueueSend(_jobs, &job, 0) == pdTRUE) return true;
    // No work was queued, so nothing can have been sent by this attempt.
    // Restore the previous timestamp before making the slot available again.
    _startedAt.store(previousStart, std::memory_order_relaxed);
    _stage.store(Stage::Idle, std::memory_order_release);
    return false;
  }

  // Ready is still busy: an unread result must never be overwritten.
  bool busy() const {
    const Stage value = stage();
    return value != Stage::Unavailable && value != Stage::Idle;
  }

  // Only true publishes context results to the owner and permits another job.
  bool take() {
    Stage expected = Stage::Ready;
    return _stage.compare_exchange_strong(expected, Stage::Idle,
                                           std::memory_order_acq_rel,
                                           std::memory_order_acquire);
  }

  Stage stage() const { return _stage.load(std::memory_order_acquire); }
  // Last accepted submission, in millis() units, retained after take(). A
  // deadline observer should inspect Queued/Running, not Starting/Submitting.
  uint32_t startedAt() const { return _startedAt.load(std::memory_order_acquire); }

  // ESP-IDF reports BYTES. Sampled on the worker after each returned callback;
  // the UI only loads the cached value. Zero until the first completed job.
  uint32_t stackHighWaterMarkBytes() const {
    return _stackHighWaterMarkBytes.load(std::memory_order_acquire);
  }

 private:
  static_assert(ATOMIC_INT_LOCK_FREE == 2 && sizeof(unsigned int) == sizeof(uint32_t),
                "RicIoWorker needs native lock-free 32-bit atomics");
  // Only function/context POINTERS cross the byte-copying FreeRTOS queue.
  // Never enqueue Arduino String, std::string, or an owning result object.
  struct Job { Work work; void* context; };
  QueueHandle_t _jobs = nullptr;
  std::atomic<Stage> _stage{Stage::Unavailable};
  std::atomic<uint32_t> _startedAt{0};
  std::atomic<uint32_t> _stackHighWaterMarkBytes{0};

  static void taskEntry(void* context) {
    static_cast<RicIoWorker*>(context)->run();
  }
  void run() {
    for (;;) {
      Job job{};
      if (xQueueReceive(_jobs, &job, portMAX_DELAY) != pdTRUE) continue;
      _stage.store(Stage::Running, std::memory_order_release);
      job.work(job.context);
      _stackHighWaterMarkBytes.store(
        static_cast<uint32_t>(uxTaskGetStackHighWaterMark(nullptr)),
        std::memory_order_release);
      _stage.store(Stage::Ready, std::memory_order_release);
    }
  }
};
