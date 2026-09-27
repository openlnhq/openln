/**
 * Strict NTAG424 DNA mock card — test double for the whole write/wipe stack.
 *
 * Validates real protocol semantics: session derivation, command MACs,
 * counters, padding, ChangeKey KeyData rules (XOR + CRC32NK), SDM file
 * settings, and SDM mirroring on plain reads (p= / c= splice with empty-
 * message CMAC, matching openLN's SUN verify).
 *
 * Any APDU the engine gets wrong is rejected with the status word a real card
 * would return.
 */

import {
  aesCbcEncrypt, aesCbcDecrypt, aesCmac, truncateMac, crcJam,
  hexToBytes, bytesToHex, concat, aesEncryptBlock, bytesEqual,
  rotateLeft1,
} from "../engine/ntag424.js";

const SW = { OK: 0x9100, AF: 0x91af, ISO_OK: 0x9000, ISO_SEC: 0x6982, INTEGRITY: 0x911e, AUTH: 0x91ae, ILLEGAL: 0x911c, PARAM: 0x919e, LENGTH: 0x917e, FILE_NOT_FOUND: 0x91f0, ABORTED: 0x91ca };

const zeros16 = () => new Uint8Array(16);
const u16le = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
const u32le = (n) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
const le16 = (b) => b[0] | (b[1] << 8);
const le24 = (b) => b[0] | (b[1] << 8) | (b[2] << 16);
const swBytes = (sw) => new Uint8Array([(sw >> 8) & 0xff, sw & 0xff]);
const resp = (sw, data) => concat(data ?? new Uint8Array(0), swBytes(sw));
const xorBytes = (a, b) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i]; return o; };

function stripPad(dec) {
  let i = dec.length - 1;
  while (i >= 0 && dec[i] === 0x00) i--;
  if (i < 0 || dec[i] !== 0x80) throw new Error("mock: invalid EV2 padding");
  return dec.subarray(0, i);
}

/** "abcd" -> bytes 61 62 63 64 (ASCII hex chars). */
function asciiHexBytes(hexLower) {
  const out = new Uint8Array(hexLower.length);
  for (let i = 0; i < hexLower.length; i++) out[i] = hexLower.charCodeAt(i);
  return out;
}

export class MockCard {
  constructor(opts = {}) {
    this.uid = hexToBytes(opts.uid ?? "04a1b2c3d4e580");
    this.keys = Array.from({ length: 5 }, (_, i) => hexToBytes(opts.keys?.[i] ?? "00".repeat(16)));
    this.keyVersions = [0, 0, 0, 0, 0];
    this.ndefFile = new Uint8Array(0);
    // Factory default NDEF file settings: comm plain, read/write free.
    this.settings = { raw: new Uint8Array([0x40, 0xe0, 0xee, 0x01, 0xff, 0xff]), sdm: false, metaKeyNo: null, fileKeyNo: null, encPiccOffset: 0, macOffset: 0 };
    this.sdmReadCtr = 0;
    this.rid = false;
    this.ridValue = null;
    this.session = null;
    this.pendingAuth = null;
    this.pendingVersionStage = 0;
    this.currentFile = null;
    this.rngBytes = opts.rngBytes ?? null;
    this.log = [];
  }

  get transport() {
    return { transceive: (apdu) => this.transceive(apdu) };
  }

  #rand(tag, len = 16) {
    if (this.rngBytes) return this.rngBytes(tag, len);
    const b = new Uint8Array(len);
    globalThis.crypto.getRandomValues(b);
    return b;
  }

  async transceive(apduIn) {
    const apdu = apduIn instanceof Uint8Array ? apduIn : new Uint8Array(apduIn);
    const out = this.#handle(apdu);
    this.log.push({ apdu: bytesToHex(apdu), resp: bytesToHex(out) });
    return out;
  }

  got(name) {
    return this.log.filter((e) => e.apdu.startsWith(name));
  }

  #handle(apdu) {
    const cla = apdu[0];
    const ins = apdu[1];
    if (cla === 0x00) return this.#iso(apdu);
    if (cla === 0x90) return this.#native(apdu);
    if (cla === 0xff && ins === 0xca) return this.#directUid();
    return resp(0x6e00);
  }

  // ── ISO 7816-4 layer ──────────────────────────────────────────────────────

  #iso(apdu) {
    const ins = apdu[1];
    if (ins === 0xa4) {
      const p1 = apdu[2];
      if (p1 === 0x04 && apdu.length >= 5) {
        const lc = apdu[4];
        const name = bytesToHex(apdu.subarray(5, 5 + lc));
        if (name !== "d2760000850101") return resp(0x6a82);
        this.currentFile = null;
        this.session = null; // selecting the DF resets authentication
        return resp(SW.ISO_OK);
      }
      if (p1 === 0x00 && apdu.length >= 7) {
        const fid = (apdu[5] << 8) | apdu[6];
        if (fid !== 0xe103 && fid !== 0xe104) return resp(0x6a82);
        this.currentFile = fid;
        return resp(SW.ISO_OK);
      }
      return resp(0x6a86);
    }
    if (ins === 0xb0) { // read binary
      if (!this.currentFile) return resp(SW.ISO_SEC);
      const offset = (apdu[2] << 8) | apdu[3];
      const le = apdu.length > 4 ? apdu[4] : 0;
      const content = this.currentFile === 0xe103 ? this.#ccFile() : this.#sdmRead();
      const n = le === 0 ? Math.min(256, Math.max(0, content.length - offset)) : le;
      return resp(SW.ISO_OK, Uint8Array.from(content.subarray(offset, Math.min(content.length, offset + n))));
    }
    if (ins === 0xd6) { // update binary
      if (this.currentFile !== 0xe104) return resp(SW.ISO_SEC);
      if (!this.#canWrite()) return resp(SW.ISO_SEC);
      const lc = apdu[4];
      const data = apdu.subarray(5, 5 + lc);
      const size = (data[0] << 8) | data[1];
      if (data.length < 2 + size) return resp(0x6700);
      this.ndefFile = concat(new Uint8Array([data[0], data[1]]), Uint8Array.from(data.subarray(2, 2 + size)));
      return resp(SW.ISO_OK);
    }
    return resp(0x6d00);
  }

  #ccFile() {
    return Uint8Array.from([0x00, 0x0f, 0x20, 0x00, 0x3b, 0x04, 0x06, 0xe1, 0x04, 0x00, 0xff, 0x00, 0x00]);
  }

  #canWrite() {
    const writeAr = this.settings.raw[2] & 0x0f;
    if (writeAr === 0x0e) return true; // free
    return this.session != null && writeAr === 0x00 && this.session.keyNo === 0;
  }

  /** NDEF read with SDM mirroring (this is what a tap sees). */
  #sdmRead() {
    const content = Uint8Array.from(this.ndefFile);
    const s = this.settings;
    if (!s.sdm || content.length === 0) return content;
    const ctr = this.sdmReadCtr;
    const ctrB = new Uint8Array([ctr & 0xff, (ctr >> 8) & 0xff, (ctr >> 16) & 0xff]);
    // p = AES-CBC(K1, 0xC7 || UID || ctr(3 LE) || 00*5, IV=0)
    const picc = concat(new Uint8Array([0xc7]), this.uid, ctrB, new Uint8Array(5));
    const p = bytesToHex(aesCbcEncrypt(this.keys[s.metaKeyNo], picc, zeros16()));
    // c = truncate(CMAC(CMAC(K2, SV2), "")) with SV2 = 3CC300010080 || UID || ctr
    const sv2 = concat(hexToBytes("3CC300010080"), this.uid, ctrB);
    const sesKey = aesCmac(this.keys[s.fileKeyNo], sv2);
    const c = bytesToHex(truncateMac(aesCmac(sesKey, new Uint8Array(0))));
    const pb = asciiHexBytes(p);
    const cb = asciiHexBytes(c);
    if (s.encPiccOffset + pb.length <= content.length) content.set(pb, s.encPiccOffset);
    if (s.macOffset + cb.length <= content.length) content.set(cb, s.macOffset);
    this.sdmReadCtr = (ctr + 1) & 0xffffff;
    return content;
  }

  // ── Native layer ──────────────────────────────────────────────────────────

  #native(apdu) {
    const ins = apdu[1];
    const lc = apdu.length > 4 ? apdu[4] : 0;
    const data = apdu.subarray(5, 5 + lc);
    switch (ins) {
      case 0x60: { // GetVersion part 1
        this.pendingVersionStage = 1;
        return resp(SW.AF, this.#versionPart(1));
      }
      case 0xaf: // continuation: auth part 2 or GetVersion 2/3
        if (this.pendingAuth) return this.#authPart2(data);
        if (this.pendingVersionStage === 1) { this.pendingVersionStage = 2; return resp(SW.AF, this.#versionPart(2)); }
        if (this.pendingVersionStage === 2) { this.pendingVersionStage = 0; return resp(SW.OK, this.#versionPart(3)); }
        return resp(SW.ABORTED);
      case 0x71:
        return this.#authPart1(data);
      case 0x64: { // GetKeyVersion (plain)
        const keyNo = data[0];
        if (keyNo > 4) return resp(SW.PARAM);
        return resp(SW.OK, Uint8Array.from([this.keyVersions[keyNo]]));
      }
      case 0xad: { // ReadData (plain read, SDM-spliced)
        const fileNo = data[0];
        if (fileNo !== 2) return resp(SW.FILE_NOT_FOUND);
        const off = le24(data.subarray(1, 4));
        const len = le24(data.subarray(4, 7));
        const content = this.#sdmRead();
        const end = len === 0 ? content.length : Math.min(content.length, off + len);
        return resp(SW.OK, Uint8Array.from(content.subarray(off, Math.max(off, end))));
      }
      case 0x51:
        return this.#secure(apdu, () => this.#rGetCardUid());
      case 0xc4:
        return this.#secure(apdu, (body, ctr) => this.#rChangeKey(body, ctr));
      case 0x5f:
        return this.#secure(apdu, (body, ctr) => this.#rChangeFileSettings(body, ctr));
      case 0x5c:
        return this.#secure(apdu, (body, ctr) => this.#rSetConfiguration(body, ctr));
      default:
        return resp(SW.ILLEGAL);
    }
  }

  #versionPart(n) {
    if (n === 1) return Uint8Array.from([0x04, 0x04, 0x02, 0x01, 0x00, 0x16, 0x03]);
    if (n === 2) return Uint8Array.from([0x04, 0x04, 0x02, 0x01, 0x00, 0x16, 0x03]);
    return concat(this.uid, hexToBytes("0102030405"), new Uint8Array([0x00, 0x00, 0x01, 0x19, 0x20, 0x00, 0x01]));
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  #authPart1(data) {
    const keyNo = data[0];
    if (keyNo > 4) return resp(SW.PARAM);
    const rndB = this.#rand("rndB");
    this.pendingAuth = { keyNo, rndB };
    const encRndB = aesCbcEncrypt(this.keys[keyNo], rndB, zeros16());
    return resp(SW.AF, encRndB);
  }

  #authPart2(data) {
    const pending = this.pendingAuth;
    this.pendingAuth = null;
    if (!pending || data.length !== 32) return resp(SW.LENGTH);
    const dec = aesCbcDecrypt(this.keys[pending.keyNo], data, zeros16());
    const rndA = dec.subarray(0, 16);
    const rndBBack = dec.subarray(16, 32);
    if (!bytesEqual(rndBBack, rotateLeft1(pending.rndB))) return resp(SW.AUTH);

    const ti = this.#rand("ti", 4);
    const rndMix = concat(
      rndA.subarray(0, 2),
      xorBytes(rndA.subarray(2, 8), pending.rndB.subarray(0, 6)),
      pending.rndB.subarray(6, 16),
      rndA.subarray(8, 16),
    );
    const encKey = aesCmac(this.keys[pending.keyNo], concat(hexToBytes("A55A00010080"), rndMix));
    const macKey = aesCmac(this.keys[pending.keyNo], concat(hexToBytes("5AA500010080"), rndMix));
    this.session = { keyNo: pending.keyNo, encKey, macKey, ti, expectedCtr: 0 };

    const plain = concat(ti, rotateLeft1(rndA), new Uint8Array(12));
    return resp(SW.OK, aesCbcEncrypt(this.keys[pending.keyNo], plain, zeros16()));
  }

  // ── Secure messaging ──────────────────────────────────────────────────────

  #secure(apdu, handler) {
    const s = this.session;
    if (!s) return resp(SW.AUTH);
    const lc = apdu[4];
    const data = apdu.subarray(5, 5 + lc);
    if (data.length < 8) return resp(SW.LENGTH);
    const mac = data.subarray(data.length - 8);
    const body = data.subarray(0, data.length - 8);
    const ctr = s.expectedCtr;
    const expMac = truncateMac(aesCmac(s.macKey, concat(new Uint8Array([apdu[1]]), u16le(ctr), s.ti, body)));
    if (!bytesEqual(expMac, mac)) return resp(SW.INTEGRITY);
    s.expectedCtr = (ctr + 1) & 0xffff;
    return handler(body, ctr);
  }

  #decryptPayload(enc, ctr) {
    const s = this.session;
    const iv = aesEncryptBlock(s.encKey, concat(hexToBytes("A55A"), s.ti, u16le(ctr), new Uint8Array(8)));
    return stripPad(aesCbcDecrypt(s.encKey, enc, iv));
  }

  #rGetCardUid() {
    const s = this.session;
    const ctrResp = s.expectedCtr; // already incremented
    const ivr = aesEncryptBlock(s.encKey, concat(hexToBytes("5AA5"), s.ti, u16le(ctrResp), new Uint8Array(8)));
    const plain = concat(this.uid, new Uint8Array([0x80]), new Uint8Array(8));
    const enc = aesCbcEncrypt(s.encKey, plain, ivr);
    const mac = truncateMac(aesCmac(s.macKey, concat(new Uint8Array([0x00]), u16le(ctrResp), s.ti, enc)));
    return resp(SW.OK, concat(enc, mac));
  }

  #rChangeKey(body, ctr) {
    const s = this.session;
    if (s.keyNo !== 0) return resp(SW.AUTH); // changes require the AppMasterKey session
    const keyNo = body[0];
    if (keyNo > 4) return resp(SW.PARAM);
    const dec = this.#decryptPayload(body.subarray(1), ctr);
    if (keyNo === 0) {
      if (dec.length < 17) return resp(SW.LENGTH);
      this.keys[0] = Uint8Array.from(dec.subarray(0, 16));
      this.keyVersions[0] = dec[16];
      this.session = null; // changing key 0 invalidates the session
      return resp(SW.OK);
    }
    if (dec.length < 21) return resp(SW.LENGTH);
    const newKey = xorBytes(dec.subarray(0, 16), this.keys[keyNo]);
    const ver = dec[16];
    const crc = dec.subarray(17, 21);
    if (!bytesEqual(crc, u32le(crcJam(newKey)))) return resp(SW.INTEGRITY);
    this.keys[keyNo] = newKey;
    this.keyVersions[keyNo] = ver;
    return resp(SW.OK);
  }

  #rChangeFileSettings(body, ctr) {
    const fileNo = body[0];
    if (fileNo !== 2) return resp(SW.FILE_NOT_FOUND);
    const dec = this.#decryptPayload(body.subarray(1), ctr);
    if (dec.length === 6) {
      this.settings = { raw: Uint8Array.from(dec), sdm: false, metaKeyNo: null, fileKeyNo: null, encPiccOffset: 0, macOffset: 0 };
      return resp(SW.OK);
    }
    if (dec.length === 15) {
      const metaKeyNo = dec[5] >> 4;
      const fileKeyNo = dec[5] & 0x0f;
      if (metaKeyNo > 4 || fileKeyNo > 4) return resp(SW.PARAM);
      this.settings = {
        raw: Uint8Array.from(dec), sdm: true, metaKeyNo, fileKeyNo,
        encPiccOffset: le24(dec.subarray(6, 9)),
        macOffset: le24(dec.subarray(9, 12)),
      };
      return resp(SW.OK);
    }
    return resp(SW.LENGTH);
  }

  #rSetConfiguration(body, ctr) {
    const option = body[0];
    const dec = this.#decryptPayload(body.subarray(1), ctr);
    if (option === 0x00 && dec.length >= 1 && (dec[0] & 0x02)) {
      this.rid = true;
      this.ridValue = concat(new Uint8Array([0x08]), this.#rand("rid", 3));
    }
    return resp(SW.OK);
  }

  #directUid() {
    if (this.rid && this.ridValue) return resp(SW.ISO_OK, Uint8Array.from(this.ridValue));
    return resp(SW.ISO_OK, Uint8Array.from(this.uid));
  }
}

export { SW as MOCK_SW };
