# RIC persistent I/O worker

Production implementation: `firmware/esp32-pos/src/core/RicIoWorker.h`.
The native executable includes that exact header. Only Arduino time, FreeRTOS,
and watchdog/system boundaries are adapted. No second worker implementation or
external test dependency is used.

## Typed API

```cpp
class RicIoWorker {
 public:
  using Work = void (*)(void*);
  enum class Stage : uint32_t {
    Unavailable, Starting, Idle, Submitting, Queued, Running, Ready
  };
  bool begin(const char* name = "ric-io", uint32_t stackBytes = 16384,
             BaseType_t core = 0, UBaseType_t priority = 1);
  bool start(Work work, void* context);
  bool busy() const;
  bool take();
  Stage stage() const;
  uint32_t startedAt() const;
  uint32_t stackHighWaterMarkBytes() const;
};
```

- **Lifetime:** workers are noncopyable/nonmovable and must outlive their task.
  Use static firmware-lifetime instances. There is deliberately no destructor
  cleanup, stop, cancel, automatic restart, or payment retry. A worker whose
  initialization failed has no live task and may be destroyed safely.
- **Setup:** `begin()` creates one task and one length-one queue. Stack size is
  **bytes**, as specified by ESP-IDF, not vanilla FreeRTOS words. Default core 0
  keeps work away from the classic CYD UI's core 1. `tskNO_AFFINITY` is accepted.
  A completed `begin()` is idempotent and ignores later arguments, even during
  work or while a result awaits consumption. A simultaneous initializer returns
  false without waiting. Invalid options, queue allocation failure, and task
  allocation failure leave `Unavailable`; failed task creation deletes its queue.
- **Submit:** `start()` claims `Idle -> Submitting` with one strong CAS before
  touching the timestamp or queue. False means this attempt did not enqueue work.
  It cannot overwrite an earlier job or unread result. A failed zero-tick queue
  send restores `Idle` and the previous timestamp. Null work is rejected; a null
  context is allowed if the callback supports it.
- **Borrowed context:** only the function and context pointers are queue-copied,
  never an Arduino `String` or owning operation struct. The caller must keep the
  context and referenced objects alive and must not read/write them after an
  accepted `start()` until its result owner successfully calls `take()`. The
  callback may modify its own context. Prepare each candidate context before
  submitting it. Concurrent producers need separate stable contexts or their own
  context-level coordination; a `busy()` check is not a shared-context lock.
- **Result ownership:** `Ready` still means `busy() == true`. Exactly one `take()`
  wins `Ready -> Idle`; its acquire operation publishes the callback's writes to
  that consumer. Failed takes do not transfer ownership. The callback is called
  synchronously on the worker task and returns before `Ready` is published.
  Complete consuming/copying the result before another producer reuses that
  context. A fast callback can finish, and its result can be taken, before the
  original submitting thread returns from `start()`.
- **Nonblocking UI:** `start` and `take` have no retry loop. Queue send uses zero
  ticks; status/timestamp/watermark reads are native lock-free 32-bit atomics.
  They never wait for I/O or queue space. FreeRTOS still uses short internal
  critical sections, so this is not a formal wait-free scheduler guarantee.
  These are task-context methods, not ISR methods. `begin()` allocates and is
  setup-only, not a UI-loop operation.
- **Stages/timing:** `Starting` and `Submitting` are temporary ownership claims.
  Use `Queued` or `Running` for a caller's I/O deadline. `startedAt()` uses
  `millis()` units, retains the last accepted submission after `take()`, and is
  wrap-safe with `uint32_t(now - startedAt())` for short deadlines. Individual
  getters are atomic snapshots, not a transaction across concurrent new jobs.
- **Fault guard:** an elapsed deadline does not prove a payment failed. Latch a
  separate application fault guard; keep the context and worker reserved. Do
  not delete/reset the task, synthesize completion, auto-resubmit, or clear a
  payment journal. A late result must be reconciled by the application. Likewise,
  `take()` of a transport error does not authorize a second payment attempt.
- **Watchdog:** the worker never registers, feeds, disables, or reconfigures a
  watchdog. The UI remains responsible for its own watchdog. Callback I/O must
  use bounded/cooperatively yielding APIs. A CPU-spinning callback can still
  starve core 0's idle task; isolating work is not a cure for arbitrary busy loops.
- **Stack telemetry:** `stackHighWaterMarkBytes()` is cached after each callback
  returns, before `Ready`. ESP-IDF's raw watermark already uses bytes; it is not
  multiplied by `sizeof(StackType_t)`. Zero means no completed-job sample yet
  (or no free stack); while work blocks, the previous sample remains available.
  Stack scanning runs only on the worker, never through this UI getter.
- **Two instances:** separate workers do not serialize shared drivers, clients,
  configuration, or hardware with one another. Main/OTA orchestration must keep
  those resources exclusive and must not schedule these jobs during OTA.

## Minimal use

Single UI producer/result owner, with static borrowed contexts:

```cpp
static RicIoWorker networkWorker;
static RicIoWorker nfcWorker;
struct Operation { String input; String output; };
static Operation operation;
static bool faultGuard = false;

static void execute(void* context) {
  auto& op = *static_cast<Operation*>(context);
  // Replace this string-only example with the synchronous I/O operation.
  // This function executes ON THE WORKER. No display/touch/UI calls here.
  op.output = op.input + ":complete";
}

// Once after configuration during setup; check the returned readiness.
const bool ready = networkWorker.begin("ric-network", 16384, 0, 1) &&
                   nfcWorker.begin("ric-nfc", 6144, 0, 1);

// In the sole UI producer, outside OTA and any unresolved-payment guard:
if (ready && !faultGuard && !networkWorker.busy()) {
  operation.input = "request";
  operation.output = "";
  const bool accepted = networkWorker.start(execute, &operation);
  // If accepted, do not touch operation until take() succeeds.
  // If false, no callback owns this submission.
  (void)accepted;
}

// In the UI loop. A real application submits on events, not every idle frame.
const auto stage = networkWorker.stage();
if ((stage == RicIoWorker::Stage::Queued || stage == RicIoWorker::Stage::Running) &&
    uint32_t(millis() - networkWorker.startedAt()) >= 30000) {
  faultGuard = true; // Observation only. Never cancel or retry the worker.
}
if (networkWorker.take()) {
  // operation.output is now owned/readable on this task. Render/reconcile it.
  // Do not automatically clear faultGuard just because a late result arrived.
}
```

`esp32/src/probe.cpp` is the complete build/link-only version using actual
Arduino `String` and two worker instances. **Do not flash that probe onto a RIC.**

## Commands

From `/home/kongzi/openln`:

```sh
node --test tests/ric-io-worker.test.mjs
RIC_IO_SANITIZER=address,undefined node --test tests/ric-io-worker.test.mjs
RIC_IO_SANITIZER=thread node --test tests/ric-io-worker.test.mjs
node --test tests/ric-firmware-policy.test.mjs tests/ric-io-worker.test.mjs
/home/kongzi/.venv-pio/bin/pio run -d tests/ric-io-worker/esp32 -e esp32dev
/home/kongzi/.venv-pio/bin/pio run -d firmware/esp32-pos -e esp32dev
```

`CXX` can select an already-installed host compiler. Native compilation uses
C++11, `-pthread -Wall -Wextra -Werror`; the runner uses temporary executables and
bounded subprocess timeouts. Only the optional ThreadSanitizer command requires
a host address-space layout supported by its installed sanitizer runtime. Do
not turn an unsupported-runtime failure into a passing/skipped safety claim.

## Coverage and observed verification

The 14 native cases cover:

1. Real callback execution on one persistent task, context result handoff/reuse.
2. Deterministic preemption during submit: duplicate caller cannot claim the slot.
3. Twelve concurrent result takers, 2,000 rounds, one owner per result.
4. Queue/task allocation faults, cleanup, retry, configurable task options.
5. Deterministic concurrent initialization and later idempotent `begin()`.
6. Failed queue send does not strand busy state or publish a phantom result.
7. Invalid setup arguments fail before allocating.
8. Real condition-variable-blocked I/O while a native display-loop heartbeat and
   caller watchdog progress; wrap-safe passive stall guard, no task/reset/retry.
9. Worker-only watermark sampling with atomic-only UI access.
10. Queued/running ownership of a noncopyable context; queue stores only pointers.
11. Completion and a subsequent job before the first `start()` returns.
12. Twelve concurrent producers, 2,000 rounds, one accepted job per result.
13. NFC worker progress while the separate network worker remains blocked.
14. Null context acceptance and null callback rejection.

TDD red runs caught missing implementation, duplicate submit, multiple result
owners, leaked initialization queue, duplicate initialization, permanently busy
failed sends, invalid initialization, and missing watermark telemetry before
those implementations/fixes. Additional regression cases exercise already-tested
paths under queued, fast-return, rollover, and multi-instance scheduling.

Observed on this host: all 14 native cases pass, including ASan+UBSan. The native
heartbeat continued for the entire 200 ms blocked-I/O test; its `METRIC` output is
an actual host-loop counter, not panel refreshes or hardware watchdog validation.
ThreadSanitizer compiled but could not start: `unsupported VMA range`, found 47,
supported 39/42/48. No ThreadSanitizer race-free claim is made.

The isolated ESP32 probe compiled and linked with Espressif32 6.13.0,
Arduino-ESP32 2.0.17 and Xtensa GCC 8.4.0. It uses real Arduino/FreeRTOS headers,
32-bit atomics, and queue/task/watermark symbols, not the host adapters. Its build
size is a string-only probe, not the production firmware's runtime memory budget
or measured TLS stack usage. No flash, boot, serial, physical display, NFC, or
actual network/payment verification is claimed by these worker tests.
