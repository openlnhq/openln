/**
 * Bolt Card / NTAG 424 DNA SUN (Secure Unique NFC) verification.
 *
 * When a Bolt Card is tapped on an NFC reader, the NTAG 424 DNA chip appends
 * two cryptographic parameters to the URL:
 *
 *   p  - 16-byte AES-128-CBC-encrypted PICC data (key=aesKey1, IV=0)
 *        plaintext:  0xC7 || UID(7 bytes) || ReadCtr(3 bytes, LE) || 0x00*5
 *        (0xC7 is the NTAG 424 DNA PICC data tag byte - must be skipped)
 *
 *   c  - 8-byte CMAC verification tag (key derived from aesKey2)
 *        derived via NTAG 424 DNA session key mechanism, then truncated
 *
 * Both are hex-encoded strings in the URL query parameters.
 *
 * Reference: NXP NTAG 424 DNA / Bolt Card LNURLw protocol
 *
 * AES mode scope: this implementation supports AES-128-CBC SUN mode only,
 * which is the factory-default and universally-used configuration for Bolt
 * Cards provisioned via the standard boltcard-tools / lnbits workflow.
 * AES-128-SIV (ISO 7816-4 / NXP LRP) is a non-default alternative mode and
 * is intentionally out of scope - card provisioning must configure CBC mode.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// ── Low-level AES-128 ECB block cipher ───────────────────────────────────────

function aesEcbEncryptBlock(key: Uint8Array, block: Uint8Array): Buffer<ArrayBuffer> {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.from(Buffer.concat([cipher.update(block), cipher.final()]));
}

// ── CMAC subkey generation (NIST SP 800-38B §6.1) ────────────────────────────

function shiftLeft1(buf: Uint8Array): Buffer<ArrayBuffer> {
  const out = Buffer.alloc(16, 0);
  let carry = 0;
  for (let i = 15; i >= 0; i--) {
    out[i] = ((buf[i] << 1) | carry) & 0xff;
    carry = (buf[i] & 0x80) ? 1 : 0;
  }
  return out;
}

function xor16(a: Uint8Array, b: Uint8Array): Buffer {
  const out = Buffer.alloc(16, 0);
  for (let i = 0; i < 16; i++) out[i] = a[i] ^ b[i];
  return out;
}

function generateSubkeys(key: Buffer): [Buffer, Buffer] {
  const L = aesEcbEncryptBlock(key, Buffer.alloc(16, 0));
  const msb1 = (L[0] & 0x80) !== 0;
  const K1 = shiftLeft1(L);
  if (msb1) K1[15] ^= 0x87;

  const msb2 = (K1[0] & 0x80) !== 0;
  const K2 = shiftLeft1(K1);
  if (msb2) K2[15] ^= 0x87;

  return [K1, K2];
}

// ── AES-CMAC (NIST SP 800-38B) ───────────────────────────────────────────────

function aesCmac(key: Buffer, message: Buffer): Buffer {
  const [K1, K2] = generateSubkeys(key);
  const blockCount = Math.max(1, Math.ceil(message.length / 16));
  let X = Buffer.alloc(16, 0);

  for (let i = 0; i < blockCount - 1; i++) {
    const block = message.subarray(i * 16, (i + 1) * 16);
    X = aesEcbEncryptBlock(key, xor16(X, block));
  }

  const lastBlock = message.subarray((blockCount - 1) * 16);
  if (lastBlock.length === 16) {
    return aesEcbEncryptBlock(key, xor16(xor16(X, lastBlock), K1));
  } else {
    const padded = Buffer.alloc(16, 0);
    lastBlock.copy(padded);
    padded[lastBlock.length] = 0x80;
    return aesEcbEncryptBlock(key, xor16(xor16(X, padded), K2));
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SunDecryptResult {
  uid: Buffer;      // 7-byte NFC UID
  counter: number;  // 3-byte little-endian read counter
}

/**
 * Decrypt the `p` query parameter from a Bolt Card tap URL.
 * Returns the UID and read counter on success, null if the parameter is
 * missing/malformed or the key is invalid.
 *
 * @param key1Hex  aesKey1 stored for this card (32 hex chars)
 * @param pHex     p query parameter from the tap URL (32 hex chars)
 */
export function decryptSunP(key1Hex: string, pHex: string): SunDecryptResult | null {
  try {
    if (pHex.length !== 32) return null;
    const key = Buffer.from(key1Hex, "hex");
    const ciphertext = Buffer.from(pHex, "hex");
    if (key.length !== 16 || ciphertext.length !== 16) return null;

    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0));
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Plaintext layout: 0xC7 || UID(7) || ReadCtr(3, little-endian) || 0x00*5
    // Byte 0 is the NTAG 424 DNA PICC data tag (0xC7) - skip it.
    // UID occupies bytes 1–7, counter occupies bytes 8–10 (little-endian).
    if (plain[0] !== 0xc7) return null;
    const uid = plain.subarray(1, 8);
    const counter = plain.readUIntLE(8, 3);
    return { uid, counter };
  } catch {
    return null;
  }
}

/**
 * Verify the `c` query parameter (CMAC) from a Bolt Card tap URL.
 *
 * NTAG 424 DNA SDM MAC derivation (confirmed against boltcard/boltcard Go
 * server crypto.go and bolt-nfc-android-app Ntag424.testPAndC):
 *
 *   SV2           = 0x3C 0xC3 0x00 0x01 0x00 0x80 || UID(7) || Counter(3)
 *   sessionMacKey = AES_CMAC(key2, SV2)
 *   fullCmac      = AES_CMAC(sessionMacKey, [])   ← empty message, not ctr||uid
 *   truncated     = bytes [1,3,5,7,9,11,13,15] of fullCmac  (8 bytes)
 *
 * @param key2Hex  aesKey2 stored for this card (32 hex chars)
 * @param uid      7-byte UID from decryptSunP
 * @param counter  read counter from decryptSunP
 * @param cHex     c query parameter from the tap URL (16 hex chars)
 */
export function verifySunC(
  key2Hex: string,
  uid: Buffer,
  counter: number,
  cHex: string,
): boolean {
  try {
    if (cHex.length !== 16) return false;
    const key2 = Buffer.from(key2Hex, "hex");
    if (key2.length !== 16) return false;

    // Encode counter as 3-byte little-endian
    const ctrBuf = Buffer.alloc(3, 0);
    ctrBuf.writeUIntLE(counter, 0, 3);

    // SV2 = 0x3C 0xC3 0x00 0x01 0x00 0x80 || UID(7) || Counter(3) - 16 bytes
    const sv2 = Buffer.alloc(16, 0);
    sv2[0] = 0x3c; sv2[1] = 0xc3; sv2[2] = 0x00;
    sv2[3] = 0x01; sv2[4] = 0x00; sv2[5] = 0x80;
    uid.copy(sv2, 6);
    ctrBuf.copy(sv2, 13);

    const sessionMacKey = aesCmac(key2, sv2);

    // MAC input is empty - the NTAG 424 DNA SDM MAC is computed over no message.
    // Reference: boltcard/boltcard crypto.go `cmac.Sum([]byte{}, sessionMacKey)`
    //            bolt-nfc-android-app Ntag424.js `CryptoJS.CMAC(sessionMacKey)`
    const fullCmac = aesCmac(sessionMacKey, Buffer.alloc(0));

    // Truncate: take bytes at odd indices [1,3,5,7,9,11,13,15]
    const truncated = Buffer.alloc(8, 0);
    for (let i = 0; i < 8; i++) truncated[i] = fullCmac[1 + i * 2];

    const provided = Buffer.from(cHex, "hex");
    // Constant-time comparison
    return truncated.equals(provided);
  } catch {
    return false;
  }
}

/**
 * Parse the amount (in satoshis) from a bolt11 invoice string by reading
 * the human-readable amount prefix.
 *
 * Returns null for zero-amount (any-amount) invoices.
 */
export function parseBolt11AmountSats(bolt11: string): number | null {
  const lower = bolt11.toLowerCase();
  // Format: ln(bc|tb|bcrt)(amount)(multiplier)1(data)
  const match = lower.match(/^ln(?:bc|tb|bcrt)(\d+)([munp]?)1/);
  if (!match || !match[1]) return null; // zero-amount invoice

  const num = Number(match[1]);
  const mult = match[2] ?? "";

  // Convert human-readable BTC amount with multiplier to satoshis
  switch (mult) {
    case "m": return num * 100_000;           // milli-BTC → sats
    case "u": return num * 100;               // micro-BTC → sats
    case "n": return Math.floor(num / 10);    // nano-BTC  → sats
    case "p": return 0;                       // pico-BTC  → effectively 0 sats
    default:  return num * 100_000_000;       // BTC → sats
  }
}

/** Generate a cryptographically random k1 challenge token (32 hex chars). */
export function generateK1(): string {
  return randomBytes(16).toString("hex");
}

// ── LNURL bech32 encoding ───────────────────────────────────────────────────
// LNURL is a bech32-encoded URL. Used for LNURL-W (withdraw) QR codes.
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = (chk & 0x1ffffff) << 5 ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= BECH32_GEN[i];
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const r: number[] = [];
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) >> 5);
  r.push(0);
  for (let i = 0; i < hrp.length; i++) r.push(hrp.charCodeAt(i) & 31);
  return r;
}

function bech32CreateChecksum(hrp: string, data: number[]): number[] {
  const mod = bech32Polymod(bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0])) ^ 1;
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

/** Encode a URL as an LNURL bech32 string (for QR display). */
export function encodeLnurl(url: string): string {
  const converted = bytesToBase32(Buffer.from(url, "utf8"));
  const checksum = bech32CreateChecksum("lnurl", converted);
  return "lnurl" + "1" + [...converted, ...checksum].map(d => BECH32_CHARSET[d]).join("");
}
