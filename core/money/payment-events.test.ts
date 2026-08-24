import test from "node:test";
import assert from "node:assert/strict";
import { redactPaymentEventDetail } from "./paymentLog.js";

test("payment event detail redaction preserves safe fields and masks secrets", () => {
  const redacted = redactPaymentEventDetail({
    nwcUrl: "nostr+walletconnect://pubkey?relay=wss://relay.example&secret=secret",
    preimage: "deadbeef",
    hasPreimage: true,
    password: "hunter2",
    authorization: "Bearer token",
    note: "safe",
    long: "x".repeat(501),
  });

  assert.deepEqual(redacted, {
    nwcUrl: "[redacted]",
    preimage: "[redacted]",
    hasPreimage: true,
    password: "[redacted]",
    authorization: "[redacted]",
    note: "safe",
    long: `${"x".repeat(500)}…`,
  });
});

test("payment event redaction masks wallet URI values even on non-secret keys", () => {
  assert.deepEqual(
    redactPaymentEventDetail({ request: "nostr+walletconnect://abc?relay=wss://relay.example" }),
    { request: "nostr+walletconnect://[redacted]" },
  );
});

test("null payment event detail remains null", () => {
  assert.equal(redactPaymentEventDetail(null), null);
  assert.equal(redactPaymentEventDetail(undefined), null);
});
