#pragma once
#include <atomic>
#include <cstdint>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <vector>
#include "freertos/queue.h"
#include "freertos/task.h"

// Only the OS boundary is adapted. Tests include the production worker itself.
namespace host {
// Deterministic scheduler preemption at an RTOS/clock boundary.
class Pause {
 public:
  void stopHere();
  bool waitForEntry();
  void release();
 private:
  std::mutex mutex;
  std::condition_variable changed;
  bool entered = false;
  bool released = false;
};
struct TaskSpec {
  std::string name;
  uint32_t stackBytes;
  UBaseType_t priority;
  BaseType_t core;
};
class Runtime {
 public:
  Runtime();
  ~Runtime();
  Runtime(const Runtime&) = delete;
  Runtime& operator=(const Runtime&) = delete;
  std::vector<TaskSpec> taskSpecs();

  std::atomic<uint32_t> clockMs{100};
  std::atomic<unsigned> taskCreates{0};
  std::atomic<unsigned> queueCreates{0};
  std::atomic<unsigned> queueDeletes{0};
  std::atomic<unsigned> sends{0};
  std::atomic<unsigned> waitingReceivers{0};
  std::atomic<unsigned> blockingUiCalls{0};
  std::atomic<unsigned> liveQueues{0};
  std::atomic<unsigned> lastQueueLength{0};
  std::atomic<unsigned> lastQueueItemBytes{0};
  std::atomic<unsigned> workerWatchdogResets{0};
  std::atomic<unsigned> uiWatchdogResets{0};
  std::atomic<unsigned> watchdogReconfigurations{0};
  std::atomic<unsigned> taskDeletes{0};
  std::atomic<unsigned> restarts{0};
  std::atomic<uint32_t> stackWatermarkBytes{10240};
  std::atomic<unsigned> watermarkQueries{0};
  std::atomic<unsigned> uiStackQueries{0};
  std::atomic<bool> failQueueCreate{false};
  std::atomic<bool> failTaskCreate{false};
  std::atomic<bool> failSend{false};
  std::atomic<bool> stopping{false};
  std::atomic<bool> pauseNextMillis{false};
  Pause inMillis;
  std::atomic<bool> pauseNextTaskCreate{false};
  Pause inTaskCreate;
  std::atomic<bool> pauseNextReceive{false};
  Pause beforeReceive;
  std::atomic<bool> pauseNextSendReturn{false};
  Pause beforeSendReturn;

  // Adapter internals; production has no access to these controls.
  std::mutex resourcesMutex;
  std::vector<std::unique_ptr<NativeQueue>> queues;
  std::vector<std::unique_ptr<NativeTask>> tasks;
  std::vector<TaskSpec> specs;
};
bool onWorkerTask();
Runtime& runtime();
}
