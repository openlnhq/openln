// BUILD/LINK TEST ONLY. No flash/deploy target is part of this test.
#include "core/RicIoWorker.h"

static RicIoWorker networkWorker;
static RicIoWorker nfcWorker;
struct Operation { String input; String output; };
static Operation networkOperation;
static Operation nfcOperation;
static void execute(void* context) {
  auto& op = *static_cast<Operation*>(context);
  op.output = op.input + ":complete"; // Actual Arduino String, never queue-copied.
}
void setup() {
  Serial.begin(115200);
  networkOperation.input = "network";
  nfcOperation.input = "nfc";
  if (networkWorker.begin()) networkWorker.start(execute, &networkOperation);
  if (nfcWorker.begin("ric-nfc", 8192, tskNO_AFFINITY, 1))
    nfcWorker.start(execute, &nfcOperation);
}
void loop() {
  if (networkWorker.take()) {
    Serial.println(networkOperation.output);
    Serial.printf("worker stack minimum free bytes=%u\n", networkWorker.stackHighWaterMarkBytes());
  }
  if (nfcWorker.take()) Serial.println(nfcOperation.output);
  if (networkWorker.busy() &&
      networkWorker.stage() == RicIoWorker::Stage::Running &&
      uint32_t(millis() - networkWorker.startedAt()) >= 30000) {
    // Observe only. Never terminate, restart, or resubmit possibly-sent work.
    Serial.println("network stalled");
  }
  delay(1);
}
