/**
 * Vector tests: AES-128 (FIPS-197), CMAC (NIST SP 800-38B), CRC32/JAMCRC
 * (vs the npm `crc` package used by the production apps), NXP MAC truncation,
 * EV2 padding, and NDEF/SDM offset math (vs the openLN server formula).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  aesEncryptBlock, aesDecryptBlock, aesCmac, crcJam, truncateMac, padForEnc,
  hexToBytes, bytesToHex, aesCbcEncrypt, aesCbcDecrypt,
} from "../engine/ntag424.js";
import { computeSdmOffsets, buildBoltcardNdefFile, buildSdmSettings, buildFactorySettings, buildEmptyNdefFile, parseNdefFileUri } from "../engine/ndef.js";

const require = createRequire(import.meta.url);
const crc = require("./oracle/node_modules/crc");

test("AES-128 FIPS-197 Appendix C.1", () => {
  const key = hexToBytes("000102030405060708090a0b0c0d0e0f");
  const pt = hexToBytes("00112233445566778899aabbccddeeff");
  assert.equal(bytesToHex(aesEncryptBlock(key, pt)), "69c4e0d86a7b0430d8cdb78070b4c55a");
  assert.equal(bytesToHex(aesDecryptBlock(key, hexToBytes("69c4e0d86a7b0430d8cdb78070b4c55a"))), bytesToHex(pt));
});

test("AES-128 FIPS-197 Appendix B", () => {
  const key = hexToBytes("2b7e151628aed2a6abf7158809cf4f3c");
  const pt = hexToBytes("3243f6a8885a308d313198a2e0370734");
  assert.equal(bytesToHex(aesEncryptBlock(key, pt)), "3925841d02dc09fbdc118597196a0b32");
});

test("AES-CBC round trip", () => {
  const key = hexToBytes("000102030405060708090a0b0c0d0e0f");
  const iv = new Uint8Array(16);
  const data = hexToBytes("00".repeat(15) + "80" + "00".repeat(16));
  const ct = aesCbcEncrypt(key, data, iv);
  assert.equal(bytesToHex(aesCbcDecrypt(key, ct, iv)), bytesToHex(data));
});

test("AES-CMAC NIST SP 800-38B vectors", () => {
  const key = hexToBytes("2b7e151628aed2a6abf7158809cf4f3c");
  assert.equal(bytesToHex(aesCmac(key, new Uint8Array(0))), "bb1d6929e95937287fa37d129b756746");
  assert.equal(bytesToHex(aesCmac(key, hexToBytes("6bc1bee22e409f96e93d7e117393172a"))), "070a16b46b4d4144f79bdd9dd04a287c");
  assert.equal(
    bytesToHex(aesCmac(key, hexToBytes("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411"))),
    "dfa66747de9ae63030ca32611497c827",
  );
  assert.equal(
    bytesToHex(aesCmac(key, hexToBytes("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710"))),
    "51f0bebf7e3b9d92fc49741779363cfe",
  );
});

test("CRC32/JAMCRC matches npm crc (used by production apps)", () => {
  const samples = [
    new Uint8Array(16),
    hexToBytes("000102030405060708090a0b0c0d0e0f"),
    hexToBytes("deadbeefcafebabe0011223344556677"),
    hexToBytes("ffffffffffffffffffffffffffffffff"),
    hexToBytes("00"),
  ];
  for (const s of samples) {
    assert.equal(crcJam(s) >>> 0, crc.crcjam(Array.from(s)) >>> 0, `crcJam mismatch for ${bytesToHex(s)}`);
  }
  assert.equal(crcJam(new TextEncoder().encode("123456789")) >>> 0, crc.crcjam("123456789") >>> 0);
});

test("NXP MAC truncation: bytes at odd indices", () => {
  const mac = hexToBytes("00112233445566778899aabbccddeeff");
  assert.equal(bytesToHex(truncateMac(mac)), "1133557799bbddff");
});

test("EV2 padding: 0x80 then zeros to the next block", () => {
  assert.equal(bytesToHex(padForEnc(hexToBytes("00".repeat(15)))), "00".repeat(15) + "80");
  assert.equal(bytesToHex(padForEnc(hexToBytes("00".repeat(17)))).length, 64);
  assert.equal(bytesToHex(padForEnc(hexToBytes("00".repeat(17)))).slice(32), "0080" + "00".repeat(14));
  assert.equal(bytesToHex(padForEnc(hexToBytes("00".repeat(21)))).length, 64);
  assert.equal(bytesToHex(padForEnc(new Uint8Array([0x02]))), "0280" + "00".repeat(14));
});

// openLN server formula: encPiccOffset = 7 + len(base) + len(sep) + 2; macOffset = encPiccOffset + 32 + 3
function openlnFormula(base) {
  const sep = base.includes("?") ? "&" : "?";
  const encPiccOffset = 7 + base.length + sep.length + 2;
  return { encPiccOffset, macOffset: encPiccOffset + 32 + 3 };
}

test("SDM offsets match the openLN server formula", () => {
  const bases = [
    "lnurlw://openln.com/card/123e4567-e89b-12d3-a456-426614174000",
    "lnurlw://openln.com/card/123e4567-e89b-12d3-a456-426614174000?x=1",
    "lnurlw://a.bc/c/1",
    "lnurlw://" + "openln.com".repeat(20) + "/card/abc",
  ];
  for (const base of bases) {
    const { encPiccOffset, macOffset } = computeSdmOffsets(base);
    const expected = openlnFormula(base);
    assert.equal(encPiccOffset, expected.encPiccOffset, `encPiccOffset for ${base}`);
    assert.equal(macOffset, expected.macOffset, `macOffset for ${base}`);
  }
});

test("NDEF file layout + SDM settings bytes", () => {
  const base = "lnurlw://openln.com/card/123e4567-e89b-12d3-a456-426614174000";
  const file = buildBoltcardNdefFile(base);
  // [2-byte BE length][D1 01 L 55 00 url]
  const len = (file[0] << 8) | file[1];
  assert.equal(len, file.length - 2);
  assert.equal(bytesToHex(file.subarray(2, 7)), "d101" + file[4].toString(16).padStart(2, "0") + "5500");
  const url = new TextDecoder().decode(file.subarray(7));
  assert.ok(url.startsWith(base + "?p=0"));
  assert.ok(url.endsWith("0000000000000000"));
  const { encPiccOffset, macOffset } = computeSdmOffsets(base);
  const settings = buildSdmSettings(encPiccOffset, macOffset);
  assert.equal(bytesToHex(settings.subarray(0, 6)), "4000e0c1ff12");
  assert.equal(settings.length, 15);
  // offsets in little-endian 3-byte form
  const o3 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
  assert.deepEqual(Array.from(settings.subarray(6, 9)), o3(encPiccOffset));
  assert.deepEqual(Array.from(settings.subarray(9, 12)), o3(macOffset));
  assert.deepEqual(Array.from(settings.subarray(12, 15)), o3(macOffset));
});

test("factory settings + empty NDEF + NDEF URI parse round-trip", () => {
  assert.equal(bytesToHex(buildFactorySettings()), "40e0ee01ffff");
  assert.equal(bytesToHex(buildEmptyNdefFile()), "0005d101015500");
  const base = "lnurlw://openln.com/card/abc?p=00000000000000000000000000000000&c=0000000000000000";
  const file = buildBoltcardNdefFile(base.replace("?p=00000000000000000000000000000000&c=0000000000000000", ""));
  assert.equal(parseNdefFileUri(file), base);
});
