import test from "node:test";
import assert from "node:assert/strict";
import { incomingFeeSats } from "./holdWrap.js";
import { calculateFee } from "./feeEngine.js";
import { isTransientRelayError, isAmbiguousPayError, relayInCooldown, noteRelayOverload } from "./nwc.js";

test("incomingFeeSats preserves the two-percent floor and merchant minimum", () => {
  assert.equal(incomingFeeSats(0), 0);
  assert.equal(incomingFeeSats(1), 0);
  assert.equal(incomingFeeSats(2), 1);
  assert.equal(incomingFeeSats(99), 2);
  assert.equal(incomingFeeSats(100), 2);
  assert.equal(incomingFeeSats(101), 3);
  assert.equal(incomingFeeSats(199), 4);
  assert.equal(incomingFeeSats(200), 4);
  assert.equal(incomingFeeSats(10_000), 200);
});

test("calculateFee keeps outbound platform fee at zero", () => {
  assert.deepEqual(calculateFee(1), { feeSats: 0, bankSats: 0, totalDeducted: 1 });
  assert.deepEqual(calculateFee(12_345), { feeSats: 0, bankSats: 0, totalDeducted: 12_345 });
});

test("connect failures are transient for every op (retry with a fresh connection)", () => {
  assert.equal(isTransientRelayError(new Error("Failed to connect to wss://relay.coinos.io")), true);
  assert.equal(isTransientRelayError(new Error("failed to connect")), true);
  assert.equal(isTransientRelayError(new Error("connect ECONNREFUSED 127.0.0.1:443")), true);
  assert.equal(isTransientRelayError(new Error("insufficient balance")), false);
  assert.equal(isTransientRelayError(new Error("Payment failed")), false);
});

test("already-underway style pay outcomes resolve as ambiguous - never a false failure", () => {
  assert.equal(isAmbiguousPayError(new Error("Payment is already underway")), true);
  assert.equal(isAmbiguousPayError(new Error("duplicate payment")), true);
  assert.equal(isAmbiguousPayError(new Error("Invoice is already paid")), true);
  assert.equal(isAmbiguousPayError(new Error("reply timeout: event abc")), true);
  assert.equal(isAmbiguousPayError(new Error("Payment failed: no route")), false);
  assert.equal(isAmbiguousPayError(new Error("Failed to connect to wss://relay.coinos.io")), false);
});

test("relay cooldown is scoped to the relay that failed", () => {
  const walletA = "nostr+walletconnect://pubkey?relay=wss%3A%2F%2Frelay-a.qa.test&secret=00";
  const walletB = "nostr+walletconnect://pubkey?relay=wss%3A%2F%2Frelay-b.qa.test&secret=00";
  assert.equal(relayInCooldown(walletA), false);
  assert.equal(relayInCooldown(walletB), false);
  assert.equal(noteRelayOverload(new Error("Failed to connect to wss://relay-a.qa.test"), walletA), true);
  assert.equal(relayInCooldown(walletA), true, "failing relay cools down");
  assert.equal(relayInCooldown(walletB), false, "other relays stay warm");
  // An overload with no identifiable relay still gates everything (safety net).
  assert.equal(noteRelayOverload(new Error("failed to publish"), undefined), true);
  assert.equal(relayInCooldown(walletB), true, "unattributable overload is a global safety net");
});
