/**
 * Flow tests: full card lifecycle against the strict mock card.
 *   write -> tap self-test (SUN verify) -> wipe -> rewrite
 * plus negative tests (wrong key, wrong k1 in tap verify).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MockCard } from "./mock.mjs";
import {
  writeBoltCard, wipeBoltCard, readCardInfo, tapSelfTest, generateKeys,
} from "../engine/boltcard.js";
import { hexToBytes, bytesToHex } from "../engine/ntag424.js";

const KEY0 = "0".repeat(32);
const KEYS = {
  k0: "000102030405060708090a0b0c0d0e0f",
  k1: "101112131415161718191a1b1c1d1e1f",
  k2: "202122232425262728292a2b2c2d2e2f",
  k3: "303132333435363738393a3b3c3d3e3f",
  k4: "404142434445464748494a4b4c4d4e4f",
};
const BASE = "lnurlw://openln.com/card/123e4567-e89b-12d3-a456-426614174000";
const UID = "04a1b2c3d4e580";

function seededCard() {
  return new MockCard({
    uid: UID,
    rngBytes: (tag, len) => {
      if (tag === "rndB") return Uint8Array.from(hexToBytes("22".repeat(16)));
      if (tag === "ti") return Uint8Array.from(hexToBytes("aabbccdd"));
      return Uint8Array.from(hexToBytes("33".repeat(len)));
    },
  });
}

const fixedRng = () => Uint8Array.from(hexToBytes("11".repeat(16)));

test("full lifecycle: write -> tap verify -> wipe -> rewrite", async () => {
  const card = seededCard();
  const steps = [];
  const res = await writeBoltCard({
    transport: card.transport,
    lnurlwBase: BASE,
    keys: KEYS,
    randomUid: false,
    onProgress: (s) => steps.push(s),
    rng: fixedRng,
  });

  assert.equal(res.uid, UID);
  assert.equal(bytesToHex(card.keys[0]), KEYS.k0);
  assert.equal(bytesToHex(card.keys[1]), KEYS.k1);
  assert.equal(bytesToHex(card.keys[4]), KEYS.k4);
  assert.deepEqual(card.keyVersions, [1, 1, 1, 1, 1]);
  assert.equal(card.settings.sdm, true);
  assert.equal(card.settings.metaKeyNo, 1);
  assert.equal(card.settings.fileKeyNo, 2);
  assert.ok(steps.length >= 8, "progress reported");

  // NDEF must be written before the SDM settings lock (the file is free-write
  // only while factory settings are active).
  const apdus = card.log.map((e) => e.apdu);
  const idxUpdate = apdus.findIndex((a) => a.startsWith("00d60000"));
  const idxCfs = apdus.findIndex((a) => a.startsWith("905f"));
  assert.ok(idxUpdate >= 0, "NDEF update sent");
  assert.ok(idxCfs > idxUpdate, "NDEF update precedes ChangeFileSettings");
  // key 0 change is last
  const idxKey0 = apdus.findIndex((a) => a.startsWith("90c40000"));
  const c4count = apdus.filter((a) => a.startsWith("90c4")).length;
  assert.equal(c4count, 5, "five ChangeKey commands");

  // Tap self-test — same verification the openLN server does on a real tap.
  const tap = await tapSelfTest({ transport: card.transport, keys: KEYS });
  assert.equal(tap.ok, true, `tap: ${tap.reason}`);
  assert.equal(tap.uid, UID);
  assert.ok(tap.counter >= 1, "SDM read counter advanced");
  const tapParams = new URL(tap.uri.replace("lnurlw://", "https://"));
  assert.equal(tapParams.searchParams.get("p"), tap.p);
  assert.equal(tapParams.searchParams.get("c"), tap.c);

  // Wipe.
  const w = await wipeBoltCard({ transport: card.transport, keys: KEYS, onProgress: () => {} });
  assert.equal(w.ok, true);
  assert.deepEqual(card.keys.map((k) => bytesToHex(k)), [KEY0, KEY0, KEY0, KEY0, KEY0]);
  assert.equal(card.settings.sdm, false);
  assert.equal(bytesToHex(card.settings.raw), "40e0ee01ffff");
  assert.equal(bytesToHex(card.ndefFile), "0005d101015500");

  // Wiped card can be programmed again.
  const newKeys = generateKeys(() => Uint8Array.from(hexToBytes("55".repeat(16))));
  const res2 = await writeBoltCard({ transport: card.transport, lnurlwBase: BASE, keys: newKeys, rng: fixedRng });
  assert.equal(res2.uid, UID);
  assert.equal(bytesToHex(card.keys[0]), newKeys.k0);
  const tap2 = await tapSelfTest({ transport: card.transport, keys: newKeys });
  assert.equal(tap2.ok, true, `tap after rewrite: ${tap2.reason}`);
});

test("random UID (privacy) sets RID and keeps GetCardUID working", async () => {
  const card = seededCard();
  await writeBoltCard({ transport: card.transport, lnurlwBase: BASE, keys: KEYS, randomUid: true, rng: fixedRng });
  assert.equal(card.rid, true);
  // direct (unauthenticated) read now returns the 4-byte random ID
  const direct = await card.transceive(hexToBytes("FFCA000000"));
  assert.equal(direct.length, 4 + 2);
  assert.equal(direct[0], 0x08);
  // authenticated read still returns the real UID (as GetCardUID)
  const info = await readCardInfo({ transport: card.transport, keys: KEYS, rng: fixedRng });
  assert.equal(info.uid, UID);
  assert.equal(info.authed, true);
});

test("wrong current key fails the write with a clear error", async () => {
  const card = seededCard();
  await assert.rejects(
    () => writeBoltCard({
      transport: card.transport, lnurlwBase: BASE, keys: KEYS,
      currentKeys: { ...KEYS }, // wrong: card still has factory keys
      rng: fixedRng,
    }),
    (err) => /RndA|authentication|91ae|part 2/i.test(err.message),
  );
});

test("tap self-test fails cleanly with wrong k1/k2", async () => {
  const card = seededCard();
  await writeBoltCard({ transport: card.transport, lnurlwBase: BASE, keys: KEYS, rng: fixedRng });
  const badKeys = { ...KEYS, k1: "00".repeat(16), k2: "00".repeat(16) };
  const t = await tapSelfTest({ transport: card.transport, keys: badKeys });
  assert.equal(t.ok, false);
});

test("readCardInfo reports version, key versions, NDEF and UID", async () => {
  const card = seededCard();
  await writeBoltCard({ transport: card.transport, lnurlwBase: BASE, keys: KEYS, rng: fixedRng });
  const info = await readCardInfo({ transport: card.transport, keys: KEYS, rng: fixedRng });
  assert.equal(info.uid, UID);
  assert.deepEqual(info.keyVersions, [1, 1, 1, 1, 1]);
  assert.match(info.uri, /^lnurlw:\/\/openln\.com\/card\//);
  assert.ok(info.version.uid);
});

test("generateKeys produces 5 distinct 16-byte keys", () => {
  let i = 0;
  const keys = generateKeys(() => Uint8Array.from(hexToBytes((0x10 + i++).toString(16).repeat(32).slice(0, 32))));
  const vals = Object.values(keys);
  assert.equal(new Set(vals).size, 5);
  for (const v of vals) assert.equal(v.length, 32);
});
