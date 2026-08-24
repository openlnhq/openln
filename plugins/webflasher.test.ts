import test from "node:test";
import assert from "node:assert/strict";
import { PARTNER_NVS_KEY, PARTNER_NVS_MAX_BYTES, PARTNER_NVS_NAMESPACE, partnerNvsWrite, validateClaimForNvs, verifyPartnerNvsReadback } from "./webflasher.js";

test("claim is normalized and encoded for the designated NVS field", () => {
  const write = partnerNvsWrite("  abc-123  ");
  assert.deepEqual(write, { namespace: PARTNER_NVS_NAMESPACE, key: PARTNER_NVS_KEY, encoding: "utf8", value: "ABC-123", overwrite: false });
});
test("claim length is bounded by NVS field size", () => {
  assert.equal(Buffer.byteLength(validateClaimForNvs("a".repeat(PARTNER_NVS_MAX_BYTES)), "utf8"), PARTNER_NVS_MAX_BYTES);
  assert.throws(() => validateClaimForNvs("a".repeat(PARTNER_NVS_MAX_BYTES + 1)), /exceeds/);
});
test("empty claims are rejected", () => assert.throws(() => partnerNvsWrite("  "), /required/));
test("readback mismatch and missing value fail closed", () => {
  verifyPartnerNvsReadback({ namespace: PARTNER_NVS_NAMESPACE, key: PARTNER_NVS_KEY, value: "ABC-123" }, "abc-123");
  assert.throws(() => verifyPartnerNvsReadback({ namespace: PARTNER_NVS_NAMESPACE, key: PARTNER_NVS_KEY, value: null }, "abc-123"), /not written/);
  assert.throws(() => verifyPartnerNvsReadback({ namespace: PARTNER_NVS_NAMESPACE, key: PARTNER_NVS_KEY, value: "OTHER" }, "abc-123"), /differs/);
});
