import test from "node:test";
import assert from "node:assert/strict";
import { incomingFeeSats } from "./holdWrap.js";
import { calculateFee } from "./feeEngine.js";

test("incomingFeeSats preserves the one-percent floor and merchant minimum", () => {
  assert.equal(incomingFeeSats(0), 0);
  assert.equal(incomingFeeSats(1), 0);
  assert.equal(incomingFeeSats(2), 1);
  assert.equal(incomingFeeSats(99), 1);
  assert.equal(incomingFeeSats(100), 1);
  assert.equal(incomingFeeSats(101), 2);
  assert.equal(incomingFeeSats(199), 2);
  assert.equal(incomingFeeSats(200), 2);
  assert.equal(incomingFeeSats(10_000), 100);
});

test("calculateFee keeps outbound platform fee at zero", () => {
  assert.deepEqual(calculateFee(1), { feeSats: 0, bankSats: 0, totalDeducted: 1 });
  assert.deepEqual(calculateFee(12_345), { feeSats: 0, bankSats: 0, totalDeducted: 12_345 });
});
