/**
 * openLN Card Writer — NTAG424 DNA secure-messaging engine.
 *
 * A from-scratch, zero-dependency ES module (browsers + Node) implementing the
 * NTAG 424 DNA / DESFire EV2 subset needed to provision and wipe Bolt Cards.
 * Every command encoding, MAC layout, counter rule and crypto step is a port of
 * the openLN + BoltCard production stack and is kept byte-identical to it:
 *
 *   - boltcard/bolt-nfc-android-app  src/class/Ntag424.js   (official creator app)
 *   - lawalletio/card-installer      src/class/Ntag424.js   (license-free fork)
 *   - BTCPayServer.NTag424           Ntag424.cs / NtagCommands.cs / Helpers.cs
 *   - openLN /opt/openln/plugins/card-ndef.ts + core/money/boltcard.ts
 *
 * Verified in tests against: FIPS-197 AES vectors, NIST SP 800-38B CMAC
 * vectors, npm `crc` (crcjam), and a differential APDU-stream comparison
 * running the actual lawalletio engine against the same mock card.
 *
 * License: MIT. Protocol facts derive from NXP AN12196 + the public BoltCard
 * ecosystem; no GPL/AGPL code was copied.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Byte utilities
// ─────────────────────────────────────────────────────────────────────────────

export function hexToBytes(hex) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2 !== 0) throw new Error("odd-length hex string");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

export function concat(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const zeros = (n) => new Uint8Array(n);

function xorBytes(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** Rotate byte array left by one byte (NXP RndB' / RndA' rule). */
export function rotateLeft1(bytes) {
  const out = new Uint8Array(bytes.length);
  out.set(bytes.subarray(1), 0);
  out[bytes.length - 1] = bytes[0];
  return out;
}

const u16le = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
const u32le = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);

// ─────────────────────────────────────────────────────────────────────────────
// AES-128 (FIPS-197) — required because WebCrypto does not expose raw ECB and
// its AES-CBC applies PKCS#7 padding, which is unusable for DESFire blocks.
// ─────────────────────────────────────────────────────────────────────────────

const { SBOX, INV_SBOX } = (() => {
  const xtime = (a) => ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff;
  const mul = (a, b) => {
    let r = 0;
    while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; }
    return r & 0xff;
  };
  const inv = new Uint8Array(256);
  for (let i = 1; i < 256; i++) {
    for (let j = 1; j < 256; j++) if (mul(i, j) === 1) { inv[i] = j; break; }
  }
  const rotl8 = (x, n) => ((x << n) | (x >> (8 - n))) & 0xff;
  const SBOX = new Uint8Array(256);
  const INV_SBOX = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const x = inv[i];
    const s = x ^ rotl8(x, 1) ^ rotl8(x, 2) ^ rotl8(x, 3) ^ rotl8(x, 4) ^ 0x63;
    SBOX[i] = s & 0xff;
    INV_SBOX[s & 0xff] = i;
  }
  return { SBOX, INV_SBOX };
})();

function expandKey(key) {
  if (key.length !== 16) throw new Error("AES-128 key must be 16 bytes");
  const rk = new Uint8Array(176);
  rk.set(key, 0);
  let rcon = 1;
  for (let i = 4; i < 44; i++) {
    const t = [rk[i * 4 - 4], rk[i * 4 - 3], rk[i * 4 - 2], rk[i * 4 - 1]];
    if (i % 4 === 0) {
      const t0 = SBOX[t[1]] ^ rcon;
      t[0] = t0; t[1] = SBOX[t[2]]; t[2] = SBOX[t[3]]; t[3] = SBOX[t[0] ^ 0 /* placeholder */];
    }
    // NOTE: recompute properly to avoid aliasing above
    if (i % 4 === 0) {
      const a0 = rk[i * 4 - 4], a1 = rk[i * 4 - 3], a2 = rk[i * 4 - 2], a3 = rk[i * 4 - 1];
      t[0] = SBOX[a1] ^ rcon;
      t[1] = SBOX[a2];
      t[2] = SBOX[a3];
      t[3] = SBOX[a0];
      rcon = ((rcon << 1) ^ ((rcon & 0x80) ? 0x1b : 0)) & 0xff;
    }
    for (let j = 0; j < 4; j++) rk[i * 4 + j] = rk[(i - 4) * 4 + j] ^ t[j];
  }
  return rk;
}

function addRoundKey(s, rk, off) {
  for (let i = 0; i < 16; i++) s[i] ^= rk[off + i];
}

function subBytes(s) { for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]]; }
function invSubBytes(s) { for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]]; }

// state layout: column-major, element (row r, col c) at index r + 4c
function shiftRows(s) {
  const t = s.slice();
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) s[r + 4 * c] = t[r + 4 * ((c + r) % 4)];
  }
}
function invShiftRows(s) {
  const t = s.slice();
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) s[r + 4 * c] = t[r + 4 * ((c - r + 4) % 4)];
  }
}
const gmul = (a, b) => {
  let r = 0;
  while (b) { if (b & 1) r ^= a; a = ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff; b >>= 1; }
  return r & 0xff;
};
function mixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    s[i] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
    s[i + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
    s[i + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
    s[i + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
  }
}
function invMixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    s[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
    s[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
    s[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
    s[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
  }
}

export function aesEncryptBlock(key, block) {
  const rk = expandKey(key);
  const s = block.slice();
  addRoundKey(s, rk, 0);
  for (let round = 1; round < 10; round++) {
    subBytes(s); shiftRows(s); mixColumns(s); addRoundKey(s, rk, round * 16);
  }
  subBytes(s); shiftRows(s); addRoundKey(s, rk, 160);
  return s;
}

export function aesDecryptBlock(key, block) {
  const rk = expandKey(key);
  const s = block.slice();
  addRoundKey(s, rk, 160);
  for (let round = 9; round >= 1; round--) {
    invShiftRows(s); invSubBytes(s); addRoundKey(s, rk, round * 16); invMixColumns(s);
  }
  invShiftRows(s); invSubBytes(s); addRoundKey(s, rk, 0);
  return s;
}

export function aesCbcEncrypt(key, data, iv) {
  if (data.length % 16 !== 0) throw new Error("CBC data must be block aligned");
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let o = 0; o < data.length; o += 16) {
    const block = aesEncryptBlock(key, xorBytes(data.subarray(o, o + 16), prev));
    out.set(block, o);
    prev = block;
  }
  return out;
}

export function aesCbcDecrypt(key, data, iv) {
  if (data.length % 16 !== 0) throw new Error("CBC data must be block aligned");
  const out = new Uint8Array(data.length);
  let prev = iv;
  for (let o = 0; o < data.length; o += 16) {
    const c = data.subarray(o, o + 16);
    out.set(xorBytes(aesDecryptBlock(key, c), prev), o);
    prev = c;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// AES-CMAC (NIST SP 800-38B)
// ─────────────────────────────────────────────────────────────────────────────

function dblBlock(b) {
  const out = new Uint8Array(16);
  let carry = 0;
  for (let i = 15; i >= 0; i--) {
    const v = b[i];
    out[i] = ((v << 1) | carry) & 0xff;
    carry = (v & 0x80) ? 1 : 0;
  }
  if (carry) out[15] ^= 0x87;
  return out;
}

export function aesCmac(key, message) {
  const msg = message instanceof Uint8Array ? message : new Uint8Array(message ?? []);
  const rk = expandKey(key);
  const K1 = dblBlock(aesEncryptBlock(key, zeros(16)));
  const K2 = dblBlock(K1);
  const n = Math.max(1, Math.ceil(msg.length / 16));
  const lastComplete = msg.length > 0 && msg.length % 16 === 0;
  let X = zeros(16);
  for (let i = 0; i < n - 1; i++) {
    X = aesEncryptBlock(key, xorBytes(X, msg.subarray(i * 16, i * 16 + 16)));
    void rk;
  }
  let last;
  if (lastComplete) {
    last = xorBytes(msg.subarray((n - 1) * 16), K1);
  } else {
    const padded = zeros(16);
    const tail = msg.subarray((n - 1) * 16);
    padded.set(tail, 0);
    padded[tail.length] = 0x80;
    last = xorBytes(padded, K2);
  }
  return aesEncryptBlock(key, xorBytes(X, last));
}

// ─────────────────────────────────────────────────────────────────────────────
// CRC-32/JAMCRC (as used by NTAG424 ChangeKey KeyData for keys 1..4)
// ─────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

/** JAMCRC: reflected CRC-32 poly 0xEDB88320, init 0xFFFFFFFF, no final xor. */
export function crcJam(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// NXP CMAC truncation: bytes at odd indices [1,3,5,7,9,11,13,15]
// (identical in the Android apps, BTCPayServer.NTag424 and openLN's Go-ported
//  server crypto: "truncated = bytes [1,3,5,...,15]")
// ─────────────────────────────────────────────────────────────────────────────

export function truncateMac(mac) {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = mac[1 + i * 2];
  return out;
}

/** DESFire EV2 secure-messaging data padding: 0x80 then zeros to block size. */
export function padForEnc(data) {
  const padLen = 16 - (data.length % 16); // 1..16, always appends
  const out = new Uint8Array(data.length + padLen);
  out.set(data, 0);
  out[data.length] = 0x80;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status words / errors
// ─────────────────────────────────────────────────────────────────────────────

export const SW = {
  OK: 0x9100,
  ADDITIONAL_FRAME: 0x91af,
  COMMAND_ABORTED: 0x91ca,
  INTEGRITY_ERROR: 0x911e,
  LENGTH_ERROR: 0x917e,
  PARAMETER_ERROR: 0x919e,
  NO_SUCH_KEY: 0x9140,
  PERMISSION_DENIED: 0x919d,
  AUTHENTICATION_DELAY: 0x91ad,
  AUTHENTICATION_ERROR: 0x91ae,
  MEMORY_ERROR: 0x91ee,
  BOUNDARY_ERROR: 0x91be,
  FILE_NOT_FOUND: 0x91f0,
  ILLEGAL_COMMAND: 0x911c,
  ISO_OK: 0x9000,
  ISO_SECURITY: 0x6982,
  ISO_FILE_NOT_FOUND: 0x6a82,
};

export const SW_NAMES = {
  0x9100: "OPERATION_OK",
  0x911c: "ILLEGAL_COMMAND_CODE",
  0x911e: "INTEGRITY_ERROR (CRC or MAC does not match, or padding invalid)",
  0x9140: "NO_SUCH_KEY",
  0x917e: "LENGTH_ERROR",
  0x919d: "PERMISSION_DENIED",
  0x919e: "PARAMETER_ERROR",
  0x91ad: "AUTHENTICATION_DELAY (failed auth counter - wait and retry)",
  0x91ae: "AUTHENTICATION_ERROR (missing/incorrect authentication)",
  0x91af: "ADDITIONAL_FRAME",
  0x91be: "BOUNDARY_ERROR",
  0x91ca: "COMMAND_ABORTED",
  0x91ee: "MEMORY_ERROR",
  0x91f0: "FILE_NOT_FOUND",
  0x9000: "ISO operation OK",
  0x6700: "Wrong or inconsistent APDU length",
  0x6982: "ISO security status not satisfied",
  0x6985: "Conditions of use not satisfied",
  0x6a82: "Application or file not found",
  0x6a86: "Wrong parameter P1/P2",
};

export function describeSw(sw) {
  return SW_NAMES[sw] ?? "unknown status word";
}

export class CardError extends Error {
  constructor(message, { sw, command, apdu } = {}) {
    const suffix = sw != null ? ` [SW ${sw.toString(16).padStart(4, "0")} ${describeSw(sw)}]` : "";
    super(`${message}${suffix}`);
    this.name = "CardError";
    this.sw = sw;
    this.command = command;
    this.apdu = apdu;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────────────────────

const KEY0_DEFAULT = new Uint8Array(16); // 00..00

export class NTag424 {
  /**
   * @param transport {{ transceive(apdu: Uint8Array): Promise<Uint8Array> }}
   *        Receives a full APDU, returns the full response including SW1SW2.
   * @param opts.rng  () => Uint8Array(16)  injectable RNG (tests)
   * @param opts.trace (apduHex, respHex) => void  APDU log hook
   * @param opts.onWarn (message, meta) => void    soft-issue reporter
   */
  constructor(transport, opts = {}) {
    if (!transport || typeof transport.transceive !== "function") {
      throw new Error("transport with transceive(apdu) is required");
    }
    this.transport = transport;
    this.rng = opts.rng ?? ((n = 16) => {
      const b = new Uint8Array(n);
      globalThis.crypto.getRandomValues(b);
      return b;
    });
    this.trace = opts.trace ?? null;
    this.onWarn = opts.onWarn ?? (() => {});
    this.session = null;
  }

  async send(apdu) {
    const resp = await this.transport.transceive(apdu);
    const out = resp instanceof Uint8Array ? resp : new Uint8Array(resp);
    this.trace?.(bytesToHex(apdu), bytesToHex(out));
    return out;
  }

  #sw(resp) {
    return (resp[resp.length - 2] << 8) | resp[resp.length - 1];
  }

  #expect(resp, sw, command) {
    const got = this.#sw(resp);
    if (got !== sw) {
      throw new CardError(`${command} failed`, {
        sw: got,
        command,
        apdu: bytesToHex(resp),
      });
    }
    return resp.subarray(0, resp.length - 2);
  }

  #requireSession(command) {
    if (!this.session) {
      throw new CardError(`${command} requires authentication first`, { command });
    }
    return this.session;
  }

  #ivCommand(ctr) {
    const s = this.session;
    return aesEncryptBlock(s.encKey, concat(hexToBytes("A55A"), s.ti, u16le(ctr), zeros(8)));
  }

  #ivResponse(ctr) {
    const s = this.session;
    return aesEncryptBlock(s.encKey, concat(hexToBytes("5AA5"), s.ti, u16le(ctr), zeros(8)));
  }

  /**
   * Generic CommMode.Full secure command.
   * MAC input = INS || CmdCtr(2 LE) || TI(4) || header || enc(data)
   * APDU      = 90 INS 0000 Lc [header enc(data)] macT 00
   */
  async #secureCommand({ ins, header = zeros(0), data = null, name, decryptResponse = false }) {
    const s = this.#requireSession(name);
    const ctr = s.ctr;
    s.ctr = (s.ctr + 1) & 0xffff;

    let body = header;
    if (data && data.length) {
      const encData = aesCbcEncrypt(s.encKey, padForEnc(data), this.#ivCommand(ctr));
      body = concat(header, encData);
    }
    const macInput = concat(new Uint8Array([ins]), u16le(ctr), s.ti, body);
    const macT = truncateMac(aesCmac(s.macKey, macInput));
    const apdu = concat(new Uint8Array([0x90, ins, 0x00, 0x00, body.length + macT.length]), body, macT, new Uint8Array([0x00]));

    const resp = await this.send(apdu);
    const rd = this.#expect(resp, SW.OK, name);
    if (!decryptResponse) return rd;

    // Response: [encData ... ] macT(8); MAC covers rc=00 || CmdCtr || TI || encData
    let encData = rd;
    let mac = null;
    if (rd.length >= 8) {
      mac = rd.subarray(rd.length - 8);
      encData = rd.subarray(0, rd.length - 8);
    }
    const ctrResp = s.ctr;
    if (mac && encData.length % 16 === 0) {
      const expMac = truncateMac(aesCmac(s.macKey, concat(new Uint8Array([0x00]), u16le(ctrResp), s.ti, encData)));
      if (!bytesEqual(expMac, mac)) {
        this.onWarn(`${name}: response MAC mismatch (soft check, continuing)`, { expected: bytesToHex(expMac), got: bytesToHex(mac) });
      }
    }
    if (encData.length === 0) return encData;
    if (encData.length % 16 !== 0) {
      throw new CardError(`${name}: encrypted response not block aligned`, { command: name });
    }
    return aesCbcDecrypt(s.encKey, encData, this.#ivResponse(ctrResp));
  }

  // ── ISO / plain commands ───────────────────────────────────────────────────

  async selectApplication() {
    const resp = await this.send(hexToBytes("00A4040007D276000085010100"));
    this.#expect(resp, SW.ISO_OK, "ISO Select Application (D2760000850101)");
  }

  async selectFile(fileId) {
    const data = concat(new Uint8Array([fileId >> 8, fileId & 0xff]), new Uint8Array(0));
    const apdu = concat(new Uint8Array([0x00, 0xa4, 0x00, 0x00, data.length]), data, new Uint8Array([0x00]));
    const resp = await this.send(apdu);
    this.#expect(resp, SW.ISO_OK, `ISO Select File ${fileId.toString(16)}`);
  }

  async getKeyVersion(keyNo) {
    const resp = await this.send(concat(new Uint8Array([0x90, 0x64, 0x00, 0x00, 0x01, keyNo]), new Uint8Array([0x00])));
    const data = this.#expect(resp, SW.OK, `GetKeyVersion ${keyNo}`);
    return data.length ? data[0] : null;
  }

  async getVersion() {
    const first = await this.send(hexToBytes("9060000000"));
    const firstData = this.#expect(first, SW.ADDITIONAL_FRAME, "GetVersion part 1");
    const second = await this.send(hexToBytes("90AF000000"));
    const secondData = this.#expect(second, SW.ADDITIONAL_FRAME, "GetVersion part 2");
    const third = await this.send(hexToBytes("90AF000000"));
    const thirdData = this.#expect(third, SW.OK, "GetVersion part 3");
    const h = bytesToHex;
    return {
      vendorId: h(firstData.subarray(0, 1)),
      hwType: h(firstData.subarray(1, 2)),
      hwSubType: h(firstData.subarray(2, 3)),
      hwMajor: h(firstData.subarray(3, 4)),
      hwMinor: h(firstData.subarray(4, 5)),
      hwStorage: firstData[5],
      hwProtocol: firstData[6],
      swType: h(secondData.subarray(0, 1)),
      swSubType: h(secondData.subarray(2, 3)),
      swMajor: h(secondData.subarray(3, 4)),
      swMinor: h(secondData.subarray(4, 5)),
      swStorage: secondData[5],
      swProtocol: secondData[6],
      uid: h(thirdData.subarray(0, 7)),
      batchNo: h(thirdData.subarray(7, 11)),
      fabKey: thirdData[11],
    };
  }

  // ── Authentication ─────────────────────────────────────────────────────────

  /**
   * AuthenticateEV2First (INS 71h). key = 16-byte Uint8Array or 32-char hex.
   * On success `this.session` is populated (TI, session keys, counter 0).
   * Returns { ti, encKey, macKey } (hex strings).
   */
  async authenticateEv2First(keyNo = 0, key = KEY0_DEFAULT) {
    const k = typeof key === "string" ? hexToBytes(key) : key;
    this.session = null;

    await this.selectApplication();
    const part1 = concat(new Uint8Array([0x90, 0x71, 0x00, 0x00, 0x05, keyNo, 0x03, 0x00, 0x00, 0x00]), new Uint8Array([0x00]));
    const resp1 = await this.send(part1);
    let rndBEnc = this.#expect(resp1, SW.ADDITIONAL_FRAME, "AuthenticateEV2First part 1");
    if (rndBEnc.length % 16 === 8) rndBEnc = rndBEnc.subarray(0, rndBEnc.length - 8); // tolerate trailing MAC
    if (rndBEnc.length !== 16) {
      throw new CardError("AuthenticateEV2First: unexpected RndB length", { command: "auth", apdu: bytesToHex(rndBEnc) });
    }
    const rndB = aesCbcDecrypt(k, rndBEnc, zeros(16));

    const rndA = this.rng(16);
    const encRndA = aesCbcEncrypt(k, concat(rndA, rotateLeft1(rndB)), zeros(16));
    const resp2 = await this.send(concat(new Uint8Array([0x90, 0xaf, 0x00, 0x00, 0x20]), encRndA, new Uint8Array([0x00])));
    let payload = this.#expect(resp2, SW.OK, "AuthenticateEV2First part 2");
    if (payload.length % 16 === 8) payload = payload.subarray(0, payload.length - 8); // strip optional MACt
    if (payload.length % 16 !== 0 || payload.length < 32) {
      throw new CardError("AuthenticateEV2First: unexpected response length", { command: "auth" });
    }
    const dec = aesCbcDecrypt(k, payload, zeros(16));
    const ti = dec.subarray(0, 4);
    const rndA2 = dec.subarray(4, 20);
    if (!bytesEqual(rndA2, rotateLeft1(rndA))) {
      throw new CardError("AuthenticateEV2First: card failed to prove the key (RndA' mismatch)", { command: "auth" });
    }

    const rndMix = concat(
      rndA.subarray(0, 2),
      xorBytes(rndA.subarray(2, 8), rndB.subarray(0, 6)),
      rndB.subarray(6, 16),
      rndA.subarray(8, 16),
    );
    const encKey = aesCmac(k, concat(hexToBytes("A55A00010080"), rndMix));
    const macKey = aesCmac(k, concat(hexToBytes("5AA500010080"), rndMix));
    this.session = { key: k, keyNo, encKey, macKey, ti, ctr: 0 };
    return { ti: bytesToHex(ti), encKey: bytesToHex(encKey), macKey: bytesToHex(macKey) };
  }

  // ── Secure commands ────────────────────────────────────────────────────────

  /**
   * ChangeKey (C4h), CommMode.Full.
   * keys 1..4: KeyData = (new XOR old) || version || CRC32NK(JAMCRC, LE)
   * key 0:     KeyData = new || version
   */
  async changeKey(keyNo, newKey, oldKey = null, version = 0) {
    const nk = typeof newKey === "string" ? hexToBytes(newKey) : newKey;
    const ok = oldKey == null
      ? zeros(16)
      : (typeof oldKey === "string" ? hexToBytes(oldKey) : oldKey);
    if (nk.length !== 16 || ok.length !== 16) throw new Error("keys must be 16 bytes");
    let data;
    if (keyNo === 0) {
      data = concat(nk, new Uint8Array([version]));
    } else {
      data = concat(xorBytes(nk, ok), new Uint8Array([version]), u32le(crcJam(nk)));
    }
    await this.#secureCommand({ ins: 0xc4, header: new Uint8Array([keyNo]), data, name: `ChangeKey ${keyNo}` });
  }

  /** ChangeFileSettings (5Fh), CommMode.Full. settings = raw payload bytes. */
  async changeFileSettings(fileNo, settings) {
    await this.#secureCommand({ ins: 0x5f, header: new Uint8Array([fileNo]), data: settings, name: `ChangeFileSettings file ${fileNo}` });
  }

  /** SetConfiguration (5Ch), CommMode.Full. */
  async setConfiguration(option, data) {
    await this.#secureCommand({ ins: 0x5c, header: new Uint8Array([option]), data, name: `SetConfiguration ${option.toString(16)}` });
  }

  /**
   * Set the card's random-ID mode ON (irreversible).
   * Configuration option 00h, "RID random ID" flag = 02h (app `setPrivateUid`).
   */
  async setRandomUid() {
    await this.setConfiguration(0x00, new Uint8Array([0x02]));
  }

  /** GetCardUID (51h), CommMode.Full — returns the 7-byte UID as hex. */
  async getCardUid() {
    const dec = await this.#secureCommand({ ins: 0x51, data: null, name: "GetCardUID", decryptResponse: true });
    if (dec.length < 7) throw new CardError("GetCardUID: short response", { command: "GetCardUID" });
    return bytesToHex(dec.subarray(0, 7));
  }

  /** ReadData (ADh), plain read of a standard data file (length 0 = to EOF). */
  async readData(fileNo, offset = 0, length = 0) {
    const data = concat(
      new Uint8Array([fileNo]),
      new Uint8Array([offset & 0xff, (offset >> 8) & 0xff, (offset >> 16) & 0xff]),
      new Uint8Array([length & 0xff, (length >> 8) & 0xff, (length >> 16) & 0xff]),
    );
    const apdu = concat(new Uint8Array([0x90, 0xad, 0x00, 0x00, 0x07]), data, new Uint8Array([0x00]));
    const resp = await this.send(apdu);
    return this.#expect(resp, SW.OK, "ReadData");
  }

  // ── NDEF file (E104h) via ISO commands, CommMode.Plain ─────────────────────

  /**
   * Write the NDEF file content ([2-byte BE length][NDEF message]) using
   * ISOUpdateBinary — mirrors the apps' `setNdefMessage` (select app, select
   * CC, select NDEF, update binary). Must be done BEFORE the file access
   * rights are locked to K0.
   */
  async writeNdef(fileContent) {
    if (fileContent.length > 253) throw new Error("NDEF too large for a single ISO update");
    await this.selectApplication();
    try {
      await this.selectFile(0xe103);
    } catch (e) {
      this.onWarn("ISO select CC file failed (continuing)", { error: String(e) });
    }
    await this.selectFile(0xe104);
    const apdu = concat(
      new Uint8Array([0x00, 0xd6, 0x00, 0x00, fileContent.length]),
      fileContent,
    );
    const resp = await this.send(apdu);
    this.#expect(resp, SW.ISO_OK, "ISOUpdateBinary (NDEF)");
  }

  /** Read the NDEF file content ([2-byte BE length][message]); plain read. */
  async readNdef() {
    await this.selectApplication();
    await this.selectFile(0xe104);
    const lenResp = await this.send(hexToBytes("00B0000002"));
    const lenData = this.#expect(lenResp, SW.ISO_OK, "ISOReadBinary (length)");
    const size = (lenData[0] << 8) | lenData[1];
    if (size === 0) return new Uint8Array(0);
    const le = size & 0xff; // Le=0 means 256
    const dataResp = await this.send(hexToBytes(`00B00002${le.toString(16).padStart(2, "0")}`));
    const data = this.#expect(dataResp, SW.ISO_OK, "ISOReadBinary (data)");
    const out = new Uint8Array(2 + size);
    out[0] = (size >> 8) & 0xff;
    out[1] = size & 0xff;
    out.set(data.subarray(0, size), 2);
    return out;
  }

  /** Best-effort UID via the PC/SC pseudo-APDU FFCA000000 (direct, no SDM). */
  static async readUidDirect(transport) {
    const resp = await transport.transceive(hexToBytes("FFCA000000"));
    const sw = (resp[resp.length - 2] << 8) | resp[resp.length - 1];
    if (sw !== 0x9000 && sw !== 0x6100) return null;
    return bytesToHex(resp.subarray(0, resp.length - 2));
  }
}

export { KEY0_DEFAULT };
