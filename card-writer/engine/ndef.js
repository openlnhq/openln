/**
 * openLN Card Writer — NDEF + SDM helpers for NTAG424 DNA Bolt Cards.
 *
 * Byte-level contract matches the openLN production stack:
 *  - server:   /opt/openln/plugins/card-ndef.ts  (computeSdmOffsets, buildSdmSettings)
 *  - apps:     boltcard/bolt-nfc-android-app + lawalletio/card-installer (WriteModal, resetFileSettings)
 *  - library:  BTCPayServer.NTag424 (FileSettings.cs)
 *
 * File layout written to the NTAG424 NDEF file (FileNo 02h):
 *
 *   [0..1]  NDEF message length, big-endian
 *   [2..]   NDEF message:  D1 01 <LEN> 55 00 <url bytes>
 *           (MB|ME|SR|TNF=1, type "U", payload = URI identifier 0x00 + UTF-8 url)
 *
 * SDM offsets point at the first byte of the zeroed placeholders, counted from
 * the start of the FILE DATA (including the 2-byte length prefix):
 *
 *   encPiccOffset = 7 + base.length + sep.length + 2        // "p=" = 2 chars
 *   macOffset     = encPiccOffset + 32 + 3                  // 32 zeros + "&c="
 *
 * Zero-dependency ES module (browsers + Node).
 */

const enc = new TextEncoder();

/** NDEF well-known URI record prefix table (NFC Forum). Index 0 = no prefix. */
export const URI_PREFIXES = [
  "", "http://www.", "https://www.", "http://", "https://", "tel:", "mailto:",
  "ftp://anonymous:anonymous@", "ftp://ftp.", "ftps://", "sftp://", "smb://",
  "nfs://", "ftp://", "dav://", "news:", "telnet://", "imap:", "rtsp://",
  "urn:", "pop:", "sip:", "sips:", "tftp:", "btspp://", "btl2cap://",
  "btgoep://", "tcpobex://", "irdaobex://", "file://", "urn:epc:id:",
  "urn:epc:tag:", "urn:epc:pat:", "urn:epc:raw:", "urn:epc:", "urn:nfc:",
];

/** Encode an NDEF message containing a single well-known URI record. */
export function encodeUriRecord(uri) {
  const url = enc.encode(uri);
  const payloadLen = 1 + url.length; // 1 = URI identifier byte
  const msg = new Uint8Array(4 + payloadLen);
  msg[0] = 0xd1; // MB|ME|SR, TNF 1 (well-known)
  msg[1] = 0x01; // record type length
  msg[2] = payloadLen & 0xff; // short record -> 1 length byte
  msg[3] = 0x55; // 'U'
  msg[4] = 0x00; // URI identifier: no prefix
  msg.set(url, 5);
  return msg;
}

/**
 * Build the full NDEF file content ([2-byte BE length][message]) for a bolt
 * card URL that already contains the zeroed p= / c= placeholders.
 */
export function buildNdefFile(urlWithPlaceholders) {
  const msg = encodeUriRecord(urlWithPlaceholders);
  const file = new Uint8Array(2 + msg.length);
  file[0] = (msg.length >> 8) & 0xff;
  file[1] = msg.length & 0xff;
  file.set(msg, 2);
  return file;
}

/** Build the bolt card URL with zeroed SDM placeholders appended. */
export function buildPlaceholderUrl(lnurlwBase) {
  const sep = lnurlwBase.includes("?") ? "&" : "?";
  return `${lnurlwBase}${sep}p=${"0".repeat(32)}&c=${"0".repeat(16)}`;
}

/** Build the NDEF file content for a bolt card lnurlw base. */
export function buildBoltcardNdefFile(lnurlwBase) {
  return buildNdefFile(buildPlaceholderUrl(lnurlwBase));
}

function indexOfBytes(haystack, needle) {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Compute SDM byte offsets from an already-built NDEF file (scan-based;
 * file offsets are counted from the start of the file data, i.e. including
 * the 2-byte length prefix).
 */
export function computeSdmOffsetsFromFile(file) {
  const pIdx = indexOfBytes(file, [0x70, 0x3d]); // "p="
  const cIdx = indexOfBytes(file, [0x63, 0x3d]); // "c="
  if (pIdx < 0 || cIdx < 0) throw new Error("placeholder p= / c= not found in NDEF file");
  const encPiccOffset = pIdx + 2; // first byte of the p placeholder
  const macOffset = cIdx + 2; // first byte of the c placeholder
  return { encPiccOffset, macOffset };
}

/**
 * Compute SDM byte offsets for ChangeFileSettings from a bolt card lnurlw base.
 * Verified byte-identical with openLN `computeSdmOffsets` and the Android
 * creator apps (`ndefMessage.indexOf('p=') + 9`).
 */
export function computeSdmOffsets(lnurlwBase) {
  const file = buildBoltcardNdefFile(lnurlwBase);
  return { ndefFile: file, ...computeSdmOffsetsFromFile(file) };
}

/** 3-byte little-endian offset. */
export function le24(n) {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
}

/**
 * SDM file settings payload for ChangeFileSettings (FileNo 02h), 15 bytes.
 * Identical to the Android app `setBoltCardFileSettings` and openLN
 * `buildSdmSettings`: SDM mirroring on, CommMode plain, AR ReadWrite/Change=K0,
 * Read=free / Write=K0, UID mirror + read counter on, ASCII encoding,
 * CtrRet=Never, MetaRead=K1 (p=), FileRead=K2 (c=).
 */
export function buildSdmSettings(encPiccOffset, macOffset) {
  const out = new Uint8Array(15);
  out.set([0x40, 0x00, 0xe0, 0xc1, 0xff, 0x12], 0);
  out.set(le24(encPiccOffset), 6);
  out.set(le24(macOffset), 9);
  out.set(le24(macOffset), 12);
  return out;
}

/**
 * Factory/reset file settings for FileNo 02h, 6 bytes — the exact payload
 * openLN returns as `factorySettings` ("40e0ee01ffff") and both Android apps
 * write in `resetFileSettings`.
 */
export function buildFactorySettings() {
  return new Uint8Array([0x40, 0xe0, 0xee, 0x01, 0xff, 0xff]);
}

/** Empty URI record used by the wipe flow (D1 01 01 55 00). */
export function encodeEmptyUriRecord() {
  return encodeUriRecord("");
}

/** NDEF file content for a wipe (empty message). */
export function buildEmptyNdefFile() {
  return buildNdefFile(""); // encodeUriRecord("") -> D1 01 01 55 00
}

/**
 * Parse an NDEF file content (with 2-byte length prefix) back to a URI string.
 * Returns null when there is no readable URI record.
 */
export function parseNdefFileUri(fileContent) {
  try {
    if (!fileContent || fileContent.length < 5) return null;
    const size = (fileContent[0] << 8) | fileContent[1];
    let msg = fileContent.subarray(2, 2 + size);
    if (!msg.length) return null;
    const hdr = msg[0];
    if ((hdr & 0x07) !== 1) return null; // TNF must be well-known
    const typeLen = msg[1];
    let offset = 2;
    let payloadLen;
    if (hdr & 0x10) {
      payloadLen = msg[offset];
      offset += 1;
    } else {
      payloadLen = (msg[offset] << 24) | (msg[offset + 1] << 16) | (msg[offset + 2] << 8) | msg[offset + 3];
      offset += 4;
    }
    if (hdr & 0x08) offset += 4; // ID length
    const type = msg.subarray(offset, offset + typeLen);
    offset += typeLen;
    if (type[0] !== 0x55) return null; // 'U'
    const payload = msg.subarray(offset, offset + payloadLen);
    if (!payload.length) return "";
    return URI_PREFIXES[payload[0]] + new TextDecoder().decode(payload.subarray(1));
  } catch {
    return null;
  }
}

export const ndefInternals = { indexOfBytes };
