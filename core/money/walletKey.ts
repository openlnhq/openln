import { Point } from "@noble/secp256k1";

/**
 * A saved NWC URL is only usable when its wallet pubkey is a real secp256k1
 * point. A malformed or off-curve key used to detonate deep inside the SDK's
 * detached request promise (an untrappable rejection that could take the
 * process down); refuse it up front with a clean error instead.
 *
 * Parsing notes (@noble/secp256k1 3.x), learned the hard way:
 * - `Point.fromHex` on a bare 64-hex string is NOT x-only parsing: it rejects
 *   even perfectly valid x-only keys with "bad point: not on curve". Never
 *   validate x-only keys by calling fromHex on the bare hex. Prefix "02" and
 *   parse the equivalent even-y compressed point instead - a 64-hex x is a
 *   usable key exactly when that parse succeeds (curve points come in +/- y
 *   pairs, so an even-y representative always exists when the point exists).
 * - This module is deliberately pure (no env, no side effects) so unit tests
 *   can exercise it directly against real keys AND junk.
 */

/** True when the host part of an NWC URL (or a raw pubkey string) is a usable secp256k1 point. */
export function isUsableWalletKey(pubkeyOrUrl: string): boolean {
  let host = pubkeyOrUrl ?? "";
  if (host.includes("://")) {
    try { host = new URL(host).hostname; } catch { return false; }
  }
  const h = host.toLowerCase();
  try {
    if (/^[0-9a-f]{64}$/.test(h)) { Point.fromHex("02" + h); return true; } // x-only (BIP340 style): even-y compressed form
    if (/^(02|03)[0-9a-f]{64}$/.test(h)) { Point.fromHex(h); return true; } // compressed
    if (/^04[0-9a-f]{128}$/.test(h)) { Point.fromHex(h); return true; } // uncompressed
  } catch { return false; }
  return false;
}

export function assertUsableWalletKey(nwcUrl: string): void {
  if (!isUsableWalletKey(nwcUrl)) {
    throw new Error("This wallet connection is not usable - its public key is missing or invalid. Connect the wallet again from its app.");
  }
}
