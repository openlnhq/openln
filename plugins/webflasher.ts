/**
 * WebSerial provisioning contract for partner attribution.
 *
 * The device stores the opaque claim code in NVS only long enough to register
 * itself. The server stores only its HMAC. Never include the code in logs or
 * durable device metadata.
 */
export const PARTNER_NVS_NAMESPACE = "openln";
export const PARTNER_NVS_KEY = "partner_claim";
export const PARTNER_NVS_ENCODING = "utf8" as const;
export const PARTNER_NVS_MAX_BYTES = 64;

export type PartnerNvsWrite = {
  namespace: typeof PARTNER_NVS_NAMESPACE;
  key: typeof PARTNER_NVS_KEY;
  encoding: typeof PARTNER_NVS_ENCODING;
  value: string;
  overwrite: false;
};

export type NvsReadback = { namespace: string; key: string; value: string | null };

export function verifyPartnerNvsReadback(readback: NvsReadback, expected: string): void {
  const claim = validateClaimForNvs(expected);
  if (readback.namespace !== PARTNER_NVS_NAMESPACE || readback.key !== PARTNER_NVS_KEY) {
    throw new Error("Device returned the wrong partner NVS field; abort flashing");
  }
  if (readback.value !== claim) {
    throw new Error(readback.value === null
      ? "Partner claim was not written; do not register this device"
      : "Partner claim read-back differs; do not register this device");
  }
}

export function validateClaimForNvs(value: string): string {
  const claim = value.trim().toUpperCase();
  if (!claim) throw new Error("Partner claim code is required");
  const bytes = Buffer.byteLength(claim, "utf8");
  if (bytes > PARTNER_NVS_MAX_BYTES) {
    throw new Error(`Partner claim code exceeds ${PARTNER_NVS_MAX_BYTES} bytes`);
  }
  return claim;
}

/** Build the exact write instruction consumed by the browser WebSerial flasher. */
export function partnerNvsWrite(value: string): PartnerNvsWrite {
  return {
    namespace: PARTNER_NVS_NAMESPACE,
    key: PARTNER_NVS_KEY,
    encoding: PARTNER_NVS_ENCODING,
    value: validateClaimForNvs(value),
    overwrite: false,
  };
}

/** Public metadata intentionally contains only the claim row reference. */
export const webflasherContract = {
  nvs: { namespace: PARTNER_NVS_NAMESPACE, key: PARTNER_NVS_KEY, encoding: PARTNER_NVS_ENCODING, maxBytes: PARTNER_NVS_MAX_BYTES, overwrite: "reject_if_populated" as const },
  failure: "abort_before_registration" as const,
  readback: "required_when_supported" as const,
};

export function deviceMetadata(claimId: string, mac: string) {
  return {
    mac: mac.trim().toUpperCase(),
    partnerClaimReference: claimId,
    nvs: {
      namespace: PARTNER_NVS_NAMESPACE,
      key: PARTNER_NVS_KEY,
      encoding: PARTNER_NVS_ENCODING,
      maxBytes: PARTNER_NVS_MAX_BYTES,
      overwrite: "reject_if_populated",
    },
  };
}
