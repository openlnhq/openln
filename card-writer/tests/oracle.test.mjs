/**
 * Differential oracle test.
 *
 * Runs the exact production engine from lawalletio/card-installer (the app
 * openLN currently mirrors for card programming) against the strict mock
 * card, then runs OUR engine through the identical flow on an identically
 * seeded mock, and requires the two APDU streams to be byte-for-byte equal.
 *
 * This validates: session derivation, command/response MACs, counters,
 * padding, ChangeKey KeyData, ChangeFileSettings bytes, NDEF writes — the
 * entire wire protocol — against an implementation that is proven on real
 * NTAG424 cards, without duplicating its bugs (it is the independent party).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MockCard } from "./mock.mjs";
import { writeBoltCard, wipeBoltCard } from "../engine/boltcard.js";
import { bytesToHex, hexToBytes } from "../engine/ntag424.js";
import { encodeUriRecord, buildPlaceholderUrl } from "../engine/ndef.js";
import { prepareOracle } from "./oracle-prepare.mjs";

const KEY0 = "0".repeat(32);
const KEYS = {
  k0: "000102030405060708090a0b0c0d0e0f",
  k1: "101112131415161718191a1b1c1d1e1f",
  k2: "202122232425262728292a2b2c2d2e2f",
  k3: "303132333435363738393a3b3c3d3e3f",
  k4: "404142434445464748494a4b4c4d4e4f",
};
const BASE = "lnurlw://openln.com/card/123e4567-e89b-12d3-a456-426614174000";

function seededCard() {
  return new MockCard({
    rngBytes: (tag) => {
      if (tag === "rndB") return Uint8Array.from(hexToBytes("22".repeat(16)));
      if (tag === "ti") return Uint8Array.from(hexToBytes("aabbccdd"));
      return Uint8Array.from(hexToBytes("33".repeat(16)));
    },
  });
}

const rngA = () => Uint8Array.from(hexToBytes("11".repeat(16)));
const lines = (card, from = 0) =>
  card.log.slice(from).map((e) => `${e.apdu}=>${e.resp}`);
const diffLines = (a, b) => {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) out.push(`#${i}\n  theirs: ${a[i] ?? "<missing>"}\n  ours:   ${b[i] ?? "<missing>"}`);
  }
  return out;
};

test("oracle diff: lawalletio engine vs ours (write + wipe, byte-for-byte)", async () => {
  prepareOracle();
  globalThis.__DET_RAND_FILL__ = 0x11;

  let target = null;
  globalThis.__ORACLE_TRANSCEIVE__ = async (bytes) =>
    Array.from(await target.transceive(Uint8Array.from(bytes)));

  const { default: La } = await import(
    `./oracle/lawalletio-ntag424.mjs?run=${Date.now()}`
  );

  // ─────────────── WRITE ───────────────
  const cardA = seededCard();
  target = cardA;
  const url = buildPlaceholderUrl(BASE);
  await La.setNdefMessage(Array.from(encodeUriRecord(url)));
  await La.AuthEv2First("00", KEY0);
  const piccOffset = url.indexOf("p=") + 9;
  const macOffset = url.indexOf("c=") + 9;
  await La.setBoltCardFileSettings(piccOffset, macOffset);
  const uidA = await La.getCardUid();
  await La.changeKey("01", KEY0, KEYS.k1, "01");
  await La.changeKey("02", KEY0, KEYS.k2, "01");
  await La.changeKey("03", KEY0, KEYS.k3, "01");
  await La.changeKey("04", KEY0, KEYS.k4, "01");
  await La.changeKey("00", KEY0, KEYS.k0, "01");

  const cardB = seededCard();
  await writeBoltCard({
    transport: cardB.transport,
    lnurlwBase: BASE,
    keys: KEYS,
    rng: rngA,
  });

  // both cards must agree about the resulting chip state
  assert.equal(bytesToHex(cardB.keys[0]), KEYS.k0, "our k0 write");
  assert.equal(bytesToHex(cardA.keys[0]), KEYS.k0, "their k0 write");
  assert.equal(bytesToHex(cardA.keys[4]), KEYS.k4, "their k4 write");
  assert.equal(
    bytesToHex(cardA.ndefFile), bytesToHex(cardB.ndefFile),
    "NDEF file content differs",
  );
  assert.equal(
    bytesToHex(cardA.settings.raw), bytesToHex(cardB.settings.raw),
    "file settings differ",
  );
  assert.equal(uidA, "04a1b2c3d4e580", "their engine must decrypt the UID via session keys");

  const logA = lines(cardA);
  const logB = lines(cardB);
  assert.equal(
    logA.length, logB.length,
    `WRITE APDU count differs: theirs=${logA.length} ours=${logB.length}\n=== THEIRS ===\n${logA.join("\n")}\n=== OURS ===\n${logB.join("\n")}`,
  );
  const writeDiffs = diffLines(logA, logB);
  assert.equal(
    writeDiffs.length, 0,
    `WRITE APDU divergences (${writeDiffs.length}):\n${writeDiffs.join("\n")}\n=== THEIRS ===\n${logA.join("\n")}\n=== OURS ===\n${logB.join("\n")}`,
  );

  // ─────────────── WIPE ───────────────
  const wipeStartA = cardA.log.length;
  target = cardA;
  await La.AuthEv2First("00", KEYS.k0);
  await La.resetFileSettings();
  await La.changeKey("01", KEYS.k1, KEY0, "00");
  await La.changeKey("02", KEYS.k2, KEY0, "00");
  await La.changeKey("03", KEYS.k3, KEY0, "00");
  await La.changeKey("04", KEYS.k4, KEY0, "00");
  await La.changeKey("00", KEYS.k0, KEY0, "00");
  await La.setNdefMessage(Array.from(encodeUriRecord("")));

  const wipeStartB = cardB.log.length;
  await wipeBoltCard({ transport: cardB.transport, keys: KEYS, rng: rngA });

  assert.deepEqual(
    cardB.keys.map(bytesToHex), [KEY0, KEY0, KEY0, KEY0, KEY0],
    "our wipe must reset all keys",
  );
  assert.deepEqual(
    cardA.keys.map(bytesToHex), [KEY0, KEY0, KEY0, KEY0, KEY0],
    "their wipe must reset all keys",
  );
  assert.equal(
    bytesToHex(cardA.ndefFile), bytesToHex(cardB.ndefFile),
    "post-wipe NDEF differs",
  );

  const wA = lines(cardA, wipeStartA);
  const wB = lines(cardB, wipeStartB);
  assert.equal(
    wA.length, wB.length,
    `WIPE APDU count differs: theirs=${wA.length} ours=${wB.length}\n=== THEIRS ===\n${wA.join("\n")}\n=== OURS ===\n${wB.join("\n")}`,
  );
  const wipeDiffs = diffLines(wA, wB);
  assert.equal(
    wipeDiffs.length, 0,
    `WIPE APDU divergences (${wipeDiffs.length}):\n${wipeDiffs.join("\n")}\n=== THEIRS ===\n${wA.join("\n")}\n=== OURS ===\n${wB.join("\n")}`,
  );
});

test("oracle diff: non-uniform RndA/RndB pins rotation semantics", async () => {
  prepareOracle();
  const rndAhex = "00112233445566778899aabbccddeeff";
  const rndBhex = "ffeeddccbbaa99887766554433221100";
  globalThis.__DET_RAND_PATTERN__ = Array.from(hexToBytes(rndAhex));

  let target = null;
  globalThis.__ORACLE_TRANSCEIVE__ = async (bytes) =>
    Array.from(await target.transceive(Uint8Array.from(bytes)));
  const { default: La } = await import(
    `./oracle/lawalletio-ntag424.mjs?run2=${Date.now()}`
  );

  const seeded = () =>
    new MockCard({
      rngBytes: (tag) => {
        if (tag === "rndB") return Uint8Array.from(hexToBytes(rndBhex));
        if (tag === "ti") return Uint8Array.from(hexToBytes("aabbccdd"));
        return Uint8Array.from(hexToBytes("33".repeat(16)));
      },
    });

  const cardA = seeded();
  target = cardA;
  const url = buildPlaceholderUrl(BASE);
  await La.setNdefMessage(Array.from(encodeUriRecord(url)));
  await La.AuthEv2First("00", KEY0);
  const piccOffset = url.indexOf("p=") + 9;
  const macOffset = url.indexOf("c=") + 9;
  await La.setBoltCardFileSettings(piccOffset, macOffset);
  const uidA = await La.getCardUid();
  await La.changeKey("01", KEY0, KEYS.k1, "01");
  await La.changeKey("02", KEY0, KEYS.k2, "01");
  await La.changeKey("03", KEY0, KEYS.k3, "01");
  await La.changeKey("04", KEY0, KEYS.k4, "01");
  await La.changeKey("00", KEY0, KEYS.k0, "01");

  const cardB = seeded();
  await writeBoltCard({
    transport: cardB.transport,
    lnurlwBase: BASE,
    keys: KEYS,
    rng: () => Uint8Array.from(hexToBytes(rndAhex)),
  });
  globalThis.__DET_RAND_PATTERN__ = null;

  assert.equal(uidA, "04a1b2c3d4e580");
  const logA = lines(cardA);
  const logB = lines(cardB);
  assert.equal(
    logA.length, logB.length,
    `ROTATION APDU count differs: theirs=${logA.length} ours=${logB.length}\n=== THEIRS ===\n${logA.join("\n")}\n=== OURS ===\n${logB.join("\n")}`,
  );
  const diffs = diffLines(logA, logB);
  assert.equal(
    diffs.length, 0,
    `ROTATION APDU divergences (${diffs.length}):\n${diffs.join("\n")}\n=== THEIRS ===\n${logA.join("\n")}\n=== OURS ===\n${logB.join("\n")}`,
  );
});
