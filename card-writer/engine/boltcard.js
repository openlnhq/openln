/**
 * openLN Card Writer — high-level Bolt Card flows for NTAG424 DNA.
 *
 * Sequence-compatible with the openLN server contract and with the production
 * card-creator apps (bolt-nfc-android-app, lawalletio/card-installer) and
 * BTCPayServer.NTag424:
 *
 *   write:  NDEF (plain) -> auth k0 (current, default on new/wiped cards)
 *           -> [SetRandomUID] -> ChangeFileSettings(SDM) -> GetCardUID
 *           -> ChangeKey 1..4 -> ChangeKey 0          (version 1)
 *
 *   wipe:   auth k0 (current) -> ChangeFileSettings(factory)
 *           -> ChangeKey 1..4 (current -> zeros) -> ChangeKey 0 -> empty NDEF
 *                                                       (version 0)
 *
 * Both flows run every ChangeKey under the k0 session (key 0 last, because
 * changing it invalidates the session) — exactly as the reference apps do.
 *
 * License: MIT.
 */

import {
  NTag424, CardError,
  hexToBytes, bytesToHex, concat,
  aesCbcDecrypt, aesCmac, truncateMac,
} from "./ntag424.js";
import {
  buildBoltcardNdefFile, buildSdmSettings, buildFactorySettings,
  buildEmptyNdefFile, computeSdmOffsets, computeSdmOffsetsFromFile,
  parseNdefFileUri,
} from "./ndef.js";

export const DEFAULT_KEY_HEX = "0".repeat(32);

/** Generate a fresh set of five AES-128 keys (hex, 32 chars each). */
export function generateKeys(rng = null) {
  const rand = rng ?? ((n) => {
    const b = new Uint8Array(n);
    globalThis.crypto.getRandomValues(b);
    return b;
  });
  return Object.fromEntries(["k0", "k1", "k2", "k3", "k4"].map((k) => [k, bytesToHex(rand(16))]));
}

// ─────────────────────────────────────────────────────────────────────────────
// SUN verification (mirrors /opt/openln/core/money/boltcard.ts — the exact
// checks the server performs on every tap)
// ─────────────────────────────────────────────────────────────────────────────

/** Decrypt the p= parameter. Returns { uidHex, counter } or null. */
export function decryptSunP(key1Hex, pHex) {
  try {
    if (typeof pHex !== "string" || pHex.length !== 32) return null;
    const key = hexToBytes(key1Hex);
    const ct = hexToBytes(pHex);
    if (key.length !== 16 || ct.length !== 16) return null;
    const plain = aesCbcDecrypt(key, ct, new Uint8Array(16));
    if (plain[0] !== 0xc7) return null;
    const uidHex = bytesToHex(plain.subarray(1, 8));
    const counter = plain[8] | (plain[9] << 8) | (plain[10] << 16);
    return { uidHex, counter };
  } catch {
    return null;
  }
}

/** Verify the c= CMAC. Empty-message CMAC (SDMMACInputOffset == SDMMACOffset). */
export function verifySunC(key2Hex, uidHex, counter, cHex) {
  try {
    if (typeof cHex !== "string" || cHex.length !== 16) return false;
    const key2 = hexToBytes(key2Hex);
    if (key2.length !== 16) return false;
    const uid = hexToBytes(uidHex);
    if (uid.length !== 7) return false;
    const ctr = new Uint8Array([counter & 0xff, (counter >> 8) & 0xff, (counter >> 16) & 0xff]);
    const sv2 = concat(hexToBytes("3CC300010080"), uid, ctr);
    const sesKey = aesCmac(key2, sv2);
    const full = aesCmac(sesKey, new Uint8Array(0));
    return bytesToHex(truncateMac(full)) === cHex.toLowerCase();
  } catch {
    return false;
  }
}

/** Extract p= / c= from a tap URL or NDEF URI. */
export function extractSunParams(text) {
  const m = String(text ?? "").match(/[?&]p=([0-9a-fA-F]{32})&c=([0-9a-fA-F]{16})/);
  return m ? { p: m[1].toLowerCase(), c: m[2].toLowerCase() } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a Bolt Card.
 *
 * @param transport            { transceive } — bridge to the card
 * @param lnurlwBase           e.g. "lnurlw://openln.com/card/<uuid>"
 * @param keys                 { k0..k4 } hex — the NEW keys (from the server)
 * @param currentKeys          { k0..k4 } hex, optional — keys currently on the
 *                             card; defaults to all-zero (factory / wiped)
 * @param ndefFileHex          optional server-provided NDEF file (hex)
 * @param sdmSettingsHex       optional server-provided SDM settings (hex)
 * @param randomUid            enable the irreversible Random-UID privacy mode
 * @param onProgress           (label) => void
 */
export async function writeBoltCard({
  transport,
  lnurlwBase,
  keys,
  currentKeys = null,
  ndefFileHex = null,
  sdmSettingsHex = null,
  randomUid = false,
  onProgress = () => {},
  rng = null,
  trace = null,
}) {
  if (!keys?.k0 || !keys?.k1 || !keys?.k2 || !keys?.k3 || !keys?.k4) {
    throw new Error("writeBoltCard: keys k0..k4 are required");
  }
  const old = currentKeys ?? { k0: DEFAULT_KEY_HEX, k1: DEFAULT_KEY_HEX, k2: DEFAULT_KEY_HEX, k3: DEFAULT_KEY_HEX, k4: DEFAULT_KEY_HEX };
  const ntag = new NTag424(transport, { rng, trace });

  // 1. NDEF first — the file is still writable without auth at this point.
  let ndefFile;
  if (ndefFileHex) {
    ndefFile = hexToBytes(ndefFileHex);
  } else {
    if (!lnurlwBase) throw new Error("writeBoltCard: lnurlwBase or ndefFileHex required");
    ndefFile = buildBoltcardNdefFile(lnurlwBase);
  }
  onProgress("Writing card data (NDEF)");
  await ntag.writeNdef(ndefFile);

  // 2. Authenticate with the current AppMasterKey (default on factory/wiped).
  onProgress("Authenticating");
  await ntag.authenticateEv2First(0, old.k0);

  // 3. Optional irreversible Random UID (privacy).
  if (randomUid) {
    onProgress("Enabling Random UID");
    await ntag.setRandomUid();
  }

  // 4. SDM file settings (use the server bytes when provided).
  onProgress("Configuring card (SDM file settings)");
  let settings;
  if (sdmSettingsHex) {
    settings = hexToBytes(sdmSettingsHex);
  } else {
    const offsets = computeSdmOffsetsFromFile(ndefFile);
    settings = buildSdmSettings(offsets.encPiccOffset, offsets.macOffset);
  }
  await ntag.changeFileSettings(0x02, settings);

  // 5. Read the real UID (encrypted response).
  onProgress("Reading card UID");
  const uid = await ntag.getCardUid();

  // 6. Change keys 1..4, then key 0 last (its change kills the session).
  for (const n of [1, 2, 3, 4]) {
    onProgress(`Writing key ${n}`);
    await ntag.changeKey(n, keys[`k${n}`], old[`k${n}`], 1);
  }
  onProgress("Writing key 0 (master)");
  await ntag.changeKey(0, keys.k0, null, 1);

  return { uid, ndefFileHex: bytesToHex(ndefFile), keys };
}

/**
 * Wipe a Bolt Card back toward factory state (all keys zero, SDM off, empty
 * NDEF) using the card's current keys.
 *
 * @param keys  { k0..k4 } hex — the keys currently on the card (from the server)
 */
export async function wipeBoltCard({
  transport,
  keys,
  factorySettingsHex = null,
  onProgress = () => {},
  rng = null,
  trace = null,
}) {
  if (!keys?.k0) throw new Error("wipeBoltCard: keys.k0 is required");
  const ntag = new NTag424(transport, { rng, trace });

  onProgress("Authenticating");
  await ntag.authenticateEv2First(0, keys.k0);

  onProgress("Resetting file settings");
  const factory = factorySettingsHex ? hexToBytes(factorySettingsHex) : buildFactorySettings();
  await ntag.changeFileSettings(0x02, factory);

  for (const n of [1, 2, 3, 4]) {
    onProgress(`Wiping key ${n}`);
    await ntag.changeKey(n, DEFAULT_KEY_HEX, keys[`k${n}`], 0);
  }
  onProgress("Wiping key 0");
  await ntag.changeKey(0, DEFAULT_KEY_HEX, null, 0);

  onProgress("Clearing NDEF");
  await ntag.writeNdef(buildEmptyNdefFile());

  return { ok: true };
}

/** Inspect a card: version info, key versions, current NDEF, optional UID. */
export async function readCardInfo({ transport, keys = null, rng = null, trace = null }) {
  const ntag = new NTag424(transport, { rng, trace });
  const info = { version: null, keyVersions: [], ndefFileHex: null, uri: null, uid: null, authed: false, errors: [] };
  try { info.version = await ntag.getVersion(); } catch (e) { info.errors.push(`getVersion: ${e.message}`); }
  for (let i = 0; i < 5; i++) {
    try { info.keyVersions.push(await ntag.getKeyVersion(i)); }
    catch { info.keyVersions.push(null); }
  }
  try {
    const ndef = await ntag.readNdef();
    info.ndefFileHex = bytesToHex(ndef);
    info.uri = parseNdefFileUri(ndef);
  } catch (e) { info.errors.push(`readNdef: ${e.message}`); }
  if (keys?.k0) {
    try {
      await ntag.authenticateEv2First(0, keys.k0);
      info.uid = await ntag.getCardUid();
      info.authed = true;
    } catch (e) { info.errors.push(`auth: ${e.message}`); }
  }
  return info;
}

/**
 * Tap self-test: read the NDEF and verify p= / c= locally, exactly like the
 * openLN server does on a real tap. Works because a plain NDEF read returns
 * the SDM-spliced values (that is how every phone reads a bolt card).
 */
export async function tapSelfTest({ transport, keys, rng = null, trace = null }) {
  const ntag = new NTag424(transport, { rng, trace });
  const ndef = await ntag.readNdef();
  const uri = parseNdefFileUri(ndef);
  const params = extractSunParams(uri ?? "");
  if (!params) return { ok: false, reason: "no p=/c= found in card NDEF", uri };
  const sun = decryptSunP(keys.k1, params.p);
  if (!sun) return { ok: false, reason: "p= decryption failed (wrong k1, or SDM not configured)", uri, p: params.p, c: params.c };
  const cOk = verifySunC(keys.k2, sun.uidHex, sun.counter, params.c);
  return {
    ok: cOk, reason: cOk ? "tap verification OK (SUN valid)" : "c= CMAC mismatch (wrong k2, or SDM config wrong)",
    uri, p: params.p, c: params.c, uid: sun.uidHex, counter: sun.counter,
  };
}

export { CardError, computeSdmOffsets };
