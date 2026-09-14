#include "core/RicIoWorker.h"
#include "host_freertos.h"
#include "esp_task_wdt.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>

#define CHECK(expr) do { if (!(expr)) { \
  std::fprintf(stderr, "%s:%d: CHECK(%s) failed\n", __FILE__, __LINE__, #expr); \
  std::abort(); \
} } while (false)

template<class Predicate> void waitUntil(Predicate predicate) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
  while (!predicate()) {
    CHECK(std::chrono::steady_clock::now() < deadline);
    std::this_thread::yield();
  }
}

class Rendezvous {
 public:
  explicit Rendezvous(unsigned count) : parties(count), remaining(count) {}
  void meet() {
    std::unique_lock<std::mutex> lock(mutex);
    const unsigned cycle = generation;
    if (--remaining == 0) {
      remaining = parties;
      ++generation;
      changed.notify_all();
    } else changed.wait(lock, [&] { return generation != cycle; });
  }
 private:
  const unsigned parties;
  unsigned remaining;
  unsigned generation = 0;
  std::mutex mutex;
  std::condition_variable changed;
};

struct TextJob {
  std::string input;
  std::string output;
  std::thread::id executedOn;
  unsigned calls = 0;
  static void execute(void* context) {
    CHECK(host::onWorkerTask());
    auto& self = *static_cast<TextJob*>(context);
    self.executedOn = std::this_thread::get_id();
    self.output = self.input + ":completed";
    ++self.calls;
  }
};

void executes_on_persistent_task() {
  // Runtime ends the HOST scheduler before the persistent worker's lifetime ends.
  RicIoWorker worker;
  host::Runtime rt;
  TextJob job;
  CHECK(worker.stage() == RicIoWorker::Stage::Unavailable);
  CHECK(!worker.busy());
  CHECK(!worker.take());
  CHECK(!worker.start(TextJob::execute, &job));
  CHECK(worker.begin());
  CHECK(worker.stage() == RicIoWorker::Stage::Idle);
  const auto specs = rt.taskSpecs();
  CHECK(specs.size() == 1);
  CHECK(specs[0].name == "ric-io");
  CHECK(specs[0].stackBytes == 16384);
  CHECK(specs[0].core == 0);
  CHECK(specs[0].priority == 1);
  for (unsigned i = 0; i < 5; ++i) {
    job.input = std::string(300, 'a' + i);
    rt.clockMs = 100 + i;
    CHECK(worker.start(TextJob::execute, &job));
    CHECK(worker.busy());
    waitUntil([&] { return worker.take(); });
    CHECK(!worker.busy());
    CHECK(!worker.take());
    CHECK(job.output == job.input + ":completed");
    CHECK(job.executedOn != std::this_thread::get_id());
    CHECK(job.calls == i + 1);
    CHECK(worker.startedAt() == 100 + i);
  }
  CHECK(rt.taskCreates == 1);
  CHECK(rt.queueCreates == 1);
  CHECK(rt.queueDeletes == 0);
  CHECK(rt.blockingUiCalls == 0);
  waitUntil([&] { return rt.waitingReceivers == 1; });
}

void concurrent_submit_claims_slot_before_clock() {
  RicIoWorker worker;
  host::Runtime rt;
  TextJob winner;
  TextJob loser;
  CHECK(worker.begin());
  rt.pauseNextMillis = true;
  bool accepted = false;
  std::thread submitter([&] { accepted = worker.start(TextJob::execute, &winner); });
  CHECK(rt.inMillis.waitForEntry());
  // First start is preempted. A second caller must not sneak into the slot.
  CHECK(!worker.start(TextJob::execute, &loser));
  CHECK(worker.busy());
  CHECK(!worker.take());
  CHECK(worker.stage() == RicIoWorker::Stage::Submitting);
  rt.inMillis.release();
  submitter.join();
  CHECK(accepted);
  waitUntil([&] { return worker.take(); });
  CHECK(winner.calls == 1);
  CHECK(loser.calls == 0);
  CHECK(rt.sends == 1);
  CHECK(rt.blockingUiCalls == 0);
}

void concurrent_take_publishes_to_exactly_one_owner() {
  RicIoWorker worker;
  host::Runtime rt;
  TextJob job;
  CHECK(worker.begin());
  constexpr unsigned takers = 12;
  constexpr unsigned rounds = 2000;
  Rendezvous start(takers + 1);
  Rendezvous finished(takers + 1);
  std::atomic<unsigned> owners{0};
  std::vector<std::thread> callers;
  for (unsigned i = 0; i < takers; ++i) callers.emplace_back([&] {
    for (unsigned round = 0; round < rounds; ++round) {
      start.meet();
      if (worker.take()) {
        CHECK(job.output == job.input + ":completed");
        ++owners;
      }
      finished.meet();
    }
  });
  for (unsigned round = 0; round < rounds; ++round) {
    job.input = "owned-result-" + std::to_string(round);
    CHECK(worker.start(TextJob::execute, &job));
    waitUntil([&] { return worker.stage() == RicIoWorker::Stage::Ready; });
    CHECK(worker.busy());
    CHECK(!worker.start(TextJob::execute, &job));
    owners = 0;
    start.meet();
    finished.meet();
    CHECK(owners == 1);
    CHECK(!worker.busy());
  }
  for (auto& caller : callers) caller.join();
  CHECK(job.calls == rounds);
  CHECK(rt.taskCreates == 1);
  CHECK(rt.blockingUiCalls == 0);
}

void allocation_failures_leave_retryable_unavailable_worker() {
  RicIoWorker worker;
  host::Runtime rt;
  TextJob job;
  rt.failQueueCreate = true;
  CHECK(!worker.begin());
  CHECK(worker.stage() == RicIoWorker::Stage::Unavailable);
  CHECK(!worker.busy());
  CHECK(!worker.take());
  CHECK(!worker.start(TextJob::execute, &job));
  CHECK(rt.taskCreates == 0);
  CHECK(rt.liveQueues == 0);

  rt.failTaskCreate = true;
  CHECK(!worker.begin());
  CHECK(worker.stage() == RicIoWorker::Stage::Unavailable);
  CHECK(!worker.busy());
  CHECK(!worker.start(TextJob::execute, &job));
  CHECK(rt.liveQueues == 0);
  CHECK(rt.queueDeletes == 1);

  CHECK(worker.begin("ric-nfc", 8192, tskNO_AFFINITY, 2));
  CHECK(worker.start(TextJob::execute, &job));
  waitUntil([&] { return worker.take(); });
  CHECK(job.calls == 1);
  CHECK(rt.taskCreates == 2); // One failed allocation, one persistent task.
  CHECK(rt.queueCreates == 3);
  CHECK(rt.liveQueues == 1);
  const auto specs = rt.taskSpecs();
  CHECK(specs.size() == 1);
  CHECK(specs[0].name == "ric-nfc");
  CHECK(specs[0].stackBytes == 8192);
  CHECK(specs[0].core == tskNO_AFFINITY);
  CHECK(specs[0].priority == 2);
}

void begin_is_single_claim_and_idempotent() {
  RicIoWorker worker;
  host::Runtime rt;
  TextJob job;
  rt.pauseNextTaskCreate = true;
  bool began = false;
  std::thread initializer([&] { began = worker.begin("ric-network", 16384, 0, 1); });
  CHECK(rt.inTaskCreate.waitForEntry());
  CHECK(!worker.begin("duplicate", 4096, tskNO_AFFINITY, 2));
  CHECK(worker.stage() == RicIoWorker::Stage::Starting);
  CHECK(worker.busy());
  CHECK(!worker.start(TextJob::execute, &job));
  CHECK(!worker.take());
  CHECK(rt.taskCreates == 1);
  CHECK(rt.queueCreates == 1);
  rt.inTaskCreate.release();
  initializer.join();
  CHECK(began);
  CHECK(worker.begin("ignored", 4096, tskNO_AFFINITY, 2));
  CHECK(worker.start(TextJob::execute, &job));
  waitUntil([&] { return worker.stage() == RicIoWorker::Stage::Ready; });
  CHECK(worker.begin());
  CHECK(worker.stage() == RicIoWorker::Stage::Ready);
  CHECK(worker.take());
  CHECK(job.calls == 1);
  CHECK(rt.taskCreates == 1);
  CHECK(rt.queueCreates == 1);
  CHECK(rt.queueDeletes == 0);
  const auto specs = rt.taskSpecs();
  CHECK(specs.size() == 1);
  CHECK(specs[0].name == "ric-network");
  CHECK(specs[0].stackBytes == 16384);
  CHECK(specs[0].core == 0);
  CHECK(specs[0].priority == 1);
}

void failed_send_releases_slot_without_publishing_a_result() {
  RicIoWorker worker;
  host::Runtime rt;
  TextJob accepted;
  TextJob rejected;
  CHECK(worker.begin());
  CHECK(worker.startedAt() == 0);
  CHECK(!worker.start(nullptr, &rejected));
  CHECK(!worker.busy());
  rt.clockMs = 4000;
  CHECK(worker.start(TextJob::execute, &accepted));
  waitUntil([&] { return worker.take(); });
  CHECK(worker.startedAt() == 4000);

  rt.clockMs = 5000;
  rt.failSend = true;
  CHECK(!worker.start(TextJob::execute, &rejected));
  CHECK(!worker.busy());
  CHECK(worker.stage() == RicIoWorker::Stage::Idle);
  CHECK(!worker.take());
  CHECK(worker.startedAt() == 4000);
  CHECK(rejected.calls == 0);

  CHECK(worker.start(TextJob::execute, &accepted));
  waitUntil([&] { return worker.take(); });
  CHECK(accepted.calls == 2);
  CHECK(worker.startedAt() == 5000);
  CHECK(rt.taskCreates == 1);
  CHECK(rt.queueCreates == 1);
  CHECK(rt.liveQueues == 1);
  CHECK(rt.blockingUiCalls == 0);
}

void invalid_setup_options_fail_without_allocating() {
  RicIoWorker worker;
  host::Runtime rt;
  CHECK(!worker.begin(nullptr));
  CHECK(!worker.begin(""));
  CHECK(!worker.begin("ric-io", 0));
  CHECK(!worker.begin("ric-io", 16384, -1));
  CHECK(!worker.begin("ric-io", 16384, portNUM_PROCESSORS));
  CHECK(!worker.begin("ric-io", 16384, 0, configMAX_PRIORITIES));
  CHECK(worker.stage() == RicIoWorker::Stage::Unavailable);
  CHECK(!worker.busy());
  CHECK(!worker.take());
  CHECK(rt.taskCreates == 0);
  CHECK(rt.queueCreates == 0);
  CHECK(worker.begin());
  CHECK(worker.stage() == RicIoWorker::Stage::Idle);
}

struct BlockingJob {
  host::Pause blocked;
  std::string input = std::string(1000, 'x');
  std::string output;
  std::atomic<unsigned> calls{0};
  const BlockingJob* original = this;
  static void execute(void* context) {
    CHECK(host::onWorkerTask());
    auto& self = *static_cast<BlockingJob*>(context);
    CHECK(&self == self.original); // An owning context must never be byte-copied.
    ++self.calls;
    self.blocked.stopHere(); // Real std::condition_variable, not a fake delay result.
    self.output = self.input + ":late-completion";
  }
};

void blocked_io_keeps_display_ticks_and_stall_guard_alive() {
  RicIoWorker worker;
  host::Runtime rt;
  BlockingJob job;
  CHECK(worker.begin());
  const uint32_t submittedAt = UINT32_MAX - 500;
  const uint32_t timeoutMs = 30000;
  rt.clockMs = submittedAt;
  CHECK(worker.start(BlockingJob::execute, &job));
  CHECK(job.blocked.waitForEntry());
  CHECK(worker.stage() == RicIoWorker::Stage::Running);
  CHECK(worker.startedAt() == submittedAt);

  // This is the CALLER'S observation, not an automatic worker timeout.
  const auto stalled = [&] {
    const auto stage = worker.stage();
    return (stage == RicIoWorker::Stage::Queued || stage == RicIoWorker::Stage::Running) &&
      uint32_t(rt.clockMs.load() - worker.startedAt()) >= timeoutMs;
  };
  rt.clockMs = submittedAt + timeoutMs - 1;
  CHECK(!stalled());
  rt.clockMs = submittedAt + timeoutMs; // Cross the 32-bit millis rollover.
  CHECK(rt.clockMs < submittedAt);
  bool faultGuard = stalled();
  CHECK(faultGuard);
  rt.clockMs = submittedAt + 10 * timeoutMs;

  uint32_t displayTicks = 0;
  const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(200);
  do {
    ++displayTicks; // Native display-loop heartbeat, NOT a real panel assertion.
    esp_task_wdt_reset(); // The caller continues servicing ITS watchdog.
    CHECK(worker.busy());
    CHECK(worker.stage() == RicIoWorker::Stage::Running);
    CHECK(!worker.take());
    CHECK(!worker.start(BlockingJob::execute, &job));
    CHECK(worker.startedAt() == submittedAt);
    faultGuard = faultGuard || stalled();
  } while (std::chrono::steady_clock::now() < until);
  CHECK(displayTicks >= 1000);
  std::printf("METRIC native_display_ticks=%u blocked_window_ms=200\n", displayTicks);
  CHECK(faultGuard);
  CHECK(job.calls == 1);
  CHECK(rt.uiWatchdogResets == displayTicks);
  CHECK(rt.workerWatchdogResets == 0);
  CHECK(rt.watchdogReconfigurations == 0);
  CHECK(rt.taskDeletes == 0);
  CHECK(rt.restarts == 0);
  CHECK(rt.taskCreates == 1);
  CHECK(rt.queueCreates == 1);
  CHECK(rt.sends == 1);
  CHECK(rt.blockingUiCalls == 0);

  job.blocked.release();
  waitUntil([&] { return worker.stage() == RicIoWorker::Stage::Ready; });
  CHECK(worker.busy());
  CHECK(!stalled());
  CHECK(faultGuard); // A late result does not itself dismiss a payment fault guard.
  CHECK(!worker.start(BlockingJob::execute, &job));
  CHECK(worker.take());
  CHECK(job.output == job.input + ":late-completion");
  CHECK(!worker.busy());
  CHECK(!worker.take());
  CHECK(job.calls == 1);
}

void stack_watermark_is_sampled_by_worker_not_ui() {
  RicIoWorker worker;
  host::Runtime rt;
  TextJob first;
  BlockingJob second;
  CHECK(worker.stackHighWaterMarkBytes() == 0);
  CHECK(worker.begin());
  rt.stackWatermarkBytes = 3456;
  CHECK(worker.start(TextJob::execute, &first));
  waitUntil([&] { return worker.take(); });
  CHECK(worker.stackHighWaterMarkBytes() == 3456);
  CHECK(rt.watermarkQueries == 1);

  rt.stackWatermarkBytes = 1800;
  CHECK(worker.start(BlockingJob::execute, &second));
  CHECK(second.blocked.waitForEntry());
  for (unsigned i = 0; i < 10000; ++i) CHECK(worker.stackHighWaterMarkBytes() == 3456);
  CHECK(rt.watermarkQueries == 1); // UI returns a cached atomic, no stack scans.
  CHECK(rt.uiStackQueries == 0);
  second.blocked.release();
  waitUntil([&] { return worker.take(); });
  CHECK(worker.stackHighWaterMarkBytes() == 1800);
  CHECK(rt.watermarkQueries == 2);
  CHECK(rt.uiStackQueries == 0);
}

void queued_job_reserves_one_pointer_only_slot() {
  RicIoWorker worker;
  host::Runtime rt;
  BlockingJob job;
  rt.pauseNextReceive = true;
  CHECK(worker.begin());
  CHECK(rt.beforeReceive.waitForEntry());
  rt.clockMs = 77;
  CHECK(worker.start(BlockingJob::execute, &job));
  CHECK(worker.stage() == RicIoWorker::Stage::Queued);
  CHECK(worker.startedAt() == 77);
  CHECK(worker.busy());
  CHECK(!worker.take());
  for (unsigned i = 0; i < 10000; ++i) CHECK(!worker.start(BlockingJob::execute, &job));
  CHECK(rt.sends == 1);
  CHECK(rt.lastQueueLength == 1);
  CHECK(rt.lastQueueItemBytes == sizeof(RicIoWorker::Work) + sizeof(void*));
  CHECK(rt.blockingUiCalls == 0);
  rt.beforeReceive.release();
  CHECK(job.blocked.waitForEntry());
  CHECK(worker.stage() == RicIoWorker::Stage::Running);
  job.blocked.release();
  waitUntil([&] { return worker.take(); });
  CHECK(job.output == job.input + ":late-completion");
}

void completion_before_start_returns_cannot_clobber_next_job() {
  RicIoWorker worker;
  host::Runtime rt;
  TextJob first;
  TextJob second;
  CHECK(worker.begin());
  rt.pauseNextSendReturn = true;
  bool accepted = false;
  std::thread submitter([&] { accepted = worker.start(TextJob::execute, &first); });
  CHECK(rt.beforeSendReturn.waitForEntry());
  waitUntil([&] { return worker.take(); });
  CHECK(first.calls == 1);
  CHECK(worker.start(TextJob::execute, &second));
  waitUntil([&] { return worker.take(); });
  CHECK(second.calls == 1);
  rt.beforeSendReturn.release();
  submitter.join();
  CHECK(accepted);
  CHECK(!worker.busy());
  CHECK(!worker.take());
  CHECK(rt.taskCreates == 1);
  CHECK(rt.queueCreates == 1);
  CHECK(rt.sends == 2);
}

void concurrent_submit_stress_accepts_one_job_per_result() {
  RicIoWorker worker;
  host::Runtime rt;
  CHECK(worker.begin());
  constexpr unsigned producers = 12;
  constexpr unsigned rounds = 2000;
  TextJob jobs[producers];
  Rendezvous start(producers + 1);
  Rendezvous finished(producers + 1);
  std::atomic<unsigned> accepted{0};
  std::atomic<unsigned> winner{0};
  std::vector<std::thread> callers;
  for (unsigned i = 0; i < producers; ++i) {
    jobs[i].input = "producer-" + std::to_string(i);
    callers.emplace_back([&, i] {
      for (unsigned round = 0; round < rounds; ++round) {
        start.meet();
        if (worker.start(TextJob::execute, &jobs[i])) { ++accepted; winner = i; }
        finished.meet();
      }
    });
  }
  for (unsigned round = 0; round < rounds; ++round) {
    accepted = 0;
    start.meet();
    finished.meet();
    CHECK(accepted == 1);
    waitUntil([&] { return worker.take(); });
    CHECK(jobs[winner].output == jobs[winner].input + ":completed");
    CHECK(!worker.take());
  }
  for (auto& caller : callers) caller.join();
  unsigned executions = 0;
  for (const auto& job : jobs) executions += job.calls;
  CHECK(executions == rounds);
  CHECK(rt.sends == rounds);
  CHECK(rt.taskCreates == 1);
  CHECK(rt.queueCreates == 1);
  CHECK(rt.blockingUiCalls == 0);
}

void independent_workers_progress_while_network_is_blocked() {
  RicIoWorker network;
  RicIoWorker nfc;
  host::Runtime rt;
  BlockingJob networkJob;
  TextJob nfcJob;
  CHECK(network.begin("ric-network", 16384, 0, 1));
  CHECK(nfc.begin("ric-nfc", 8192, 0, 1));
  CHECK(network.start(BlockingJob::execute, &networkJob));
  CHECK(networkJob.blocked.waitForEntry());
  for (unsigned i = 0; i < 50; ++i) {
    CHECK(nfc.start(TextJob::execute, &nfcJob));
    waitUntil([&] { return nfc.take(); });
    CHECK(network.busy());
    CHECK(!network.take());
    CHECK(network.stage() == RicIoWorker::Stage::Running);
    CHECK(!nfc.busy());
  }
  CHECK(nfcJob.calls == 50);
  CHECK(networkJob.calls == 1);
  CHECK(rt.taskCreates == 2);
  CHECK(rt.queueCreates == 2);
  CHECK(rt.blockingUiCalls == 0);
  const auto specs = rt.taskSpecs();
  CHECK(specs.size() == 2);
  CHECK(specs[0].stackBytes == 16384);
  CHECK(specs[1].stackBytes == 8192);
  networkJob.blocked.release();
  waitUntil([&] { return network.take(); });
}

void null_context_is_allowed_but_null_work_is_not() {
  RicIoWorker worker;
  host::Runtime rt;
  CHECK(worker.begin());
  CHECK(!worker.start(nullptr, nullptr));
  CHECK(worker.start([](void* context) {
    CHECK(context == nullptr);
    CHECK(host::onWorkerTask());
  }, nullptr));
  waitUntil([&] { return worker.take(); });
  CHECK(!worker.busy());
  CHECK(rt.sends == 1);
}

struct TestCase { const char* name; void (*run)(); };
const TestCase cases[] = {
  {"executes_on_persistent_task", executes_on_persistent_task},
  {"concurrent_submit_claims_slot_before_clock", concurrent_submit_claims_slot_before_clock},
  {"concurrent_take_publishes_to_exactly_one_owner", concurrent_take_publishes_to_exactly_one_owner},
  {"allocation_failures_leave_retryable_unavailable_worker", allocation_failures_leave_retryable_unavailable_worker},
  {"begin_is_single_claim_and_idempotent", begin_is_single_claim_and_idempotent},
  {"failed_send_releases_slot_without_publishing_a_result", failed_send_releases_slot_without_publishing_a_result},
  {"invalid_setup_options_fail_without_allocating", invalid_setup_options_fail_without_allocating},
  {"blocked_io_keeps_display_ticks_and_stall_guard_alive", blocked_io_keeps_display_ticks_and_stall_guard_alive},
  {"stack_watermark_is_sampled_by_worker_not_ui", stack_watermark_is_sampled_by_worker_not_ui},
  {"queued_job_reserves_one_pointer_only_slot", queued_job_reserves_one_pointer_only_slot},
  {"completion_before_start_returns_cannot_clobber_next_job", completion_before_start_returns_cannot_clobber_next_job},
  {"concurrent_submit_stress_accepts_one_job_per_result", concurrent_submit_stress_accepts_one_job_per_result},
  {"independent_workers_progress_while_network_is_blocked", independent_workers_progress_while_network_is_blocked},
  {"null_context_is_allowed_but_null_work_is_not", null_context_is_allowed_but_null_work_is_not},
};
int main(int argc, char** argv) {
  if (argc == 2 && std::strcmp(argv[1], "--list") == 0) {
    for (const auto& test : cases) std::puts(test.name);
    return 0;
  }
  if (argc == 2) for (const auto& test : cases) {
    if (std::strcmp(argv[1], test.name) == 0) {
      test.run();
      std::printf("PASS %s\n", test.name);
      return 0;
    }
  }
  std::fputs("Expected --list or one registered test name\n", stderr);
  return 2;
}
