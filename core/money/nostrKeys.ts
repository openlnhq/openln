// @ts-nocheck
//
/**
 * Nostr keypair utilities for bitPOS/Veil integration.
 *
 * Each bitPOS account gets a secp256k1 keypair on creation.
 * The private key (hex) is stored AES-256-GCM encrypted using the existing
 * SESSION_SECRET-derived key (same as all other encrypted values in the system).
 * The public key (x-only hex) is stored in plain text - it is public data.
 *
 * The keypair drives the Veil NIP-47 wallet connection:
 *   nostr+walletconnect://<VEIL_PUBKEY>?relay=<VEIL_RELAY>&secret=<user-privkey-hex>
 */
import { randomBytes } from "crypto";

// ── secp256k1 scalar validation ───────────────────────────────────────────────
// A valid secp256k1 private key must be in [1, n-1] where
// n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

function isValidPrivKey(bytes: Buffer): boolean {
  if (bytes.length !== 32) return false;
  const n = BigInt("0x" + bytes.toString("hex"));
  return n > 0n && n < SECP256K1_N;
}

// ── bech32 (nostr uses standard bech32 for npub/nsec) ────────────────────────
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = (chk & 0x1ffffff) << 5 ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= BECH32_GEN[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const r: number[] = [];
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) >> 5);
  r.push(0);
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) & 31);
  return r;
}

function createChecksum(hrp: string, data: number[]): number[] {
  const mod = polymod(hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0])) ^ 1;
  return Array.from({ length: 6 }, (_, p) => (mod >> (5 * (5 - p))) & 31);
}

function bytesToBase32(data: Buffer): number[] {
  let acc = 0, bits = 0;
  const result: number[] = [];
  for (const byte of data) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; result.push((acc >> bits) & 31); }
  }
  if (bits > 0) result.push((acc << (5 - bits)) & 31);
  return result;
}

function bech32Encode(hrp: string, data: Buffer): string {
  const converted = bytesToBase32(data);
  const checksum = createChecksum(hrp, converted);
  return hrp + "1" + [...converted, ...checksum].map(d => BECH32_CHARSET[d]).join("");
}

// ── Public key derivation (secp256k1 x-only / schnorr) ───────────────────────
// We use @noble/secp256k1 which is already installed in api-server.
// Dynamic import to handle ESM-only package in CJS-compatible way.
async function getXOnlyPubKey(privKeyBytes: Buffer): Promise<Buffer> {
  const { schnorr } = await import("@noble/secp256k1");
  const pubKeyBytes = schnorr.getPublicKey(privKeyBytes); // returns 32-byte x-only Uint8Array
  return Buffer.from(pubKeyBytes);
}

// ── Exported types & functions ────────────────────────────────────────────────

export interface NostrKeypair {
  privKeyHex: string;
  pubKeyHex: string;
  npub: string;
  nsec: string;
}

/**
 * Generate a fresh nostr keypair. Returns hex keys and bech32-encoded npub/nsec.
 */
export async function generateKeypair(): Promise<NostrKeypair> {
  let privKeyBytes: Buffer;
  do {
    privKeyBytes = randomBytes(32);
  } while (!isValidPrivKey(privKeyBytes));

  const pubKeyBytes = await getXOnlyPubKey(privKeyBytes);
  const privKeyHex = privKeyBytes.toString("hex");
  const pubKeyHex  = pubKeyBytes.toString("hex");

  return {
    privKeyHex,
    pubKeyHex,
    npub: bech32Encode("npub", pubKeyBytes),
    nsec: bech32Encode("nsec", privKeyBytes),
  };
}

/**
 * Derive the x-only public key for a private key hex string. Used to verify
 * client-generated keypairs before storing them. Throws on invalid keys.
 */
export async function derivePubKeyHex(privKeyHex: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/i.test(privKeyHex)) throw new Error("Private key must be 64 hex characters");
  const bytes = Buffer.from(privKeyHex, "hex");
  if (!isValidPrivKey(bytes)) throw new Error("Invalid secp256k1 private key");
  return (await getXOnlyPubKey(bytes)).toString("hex");
}

/**
 * Decode a stored keypair (hex strings) into the full NostrKeypair shape.
 * Used when returning the keypair to the user for PDF download.
 */
export async function decodeKeypair(privKeyHex: string, pubKeyHex: string): Promise<NostrKeypair> {
  return {
    privKeyHex,
    pubKeyHex,
    npub: bech32Encode("npub", Buffer.from(pubKeyHex, "hex")),
    nsec: bech32Encode("nsec", Buffer.from(privKeyHex, "hex")),
  };
}
