/** NTAG424 binary contract ported from bitPOS routes/pos.ts; no APDU changes. */
// Build the NDEF file for a Bolt Card lnurlw URL (ported from card-writer/utils/ndef.ts).
// The NTAG424 chip overwrites the zeroed p= and c= placeholders at each tap.
function buildNdefFile(lnurlwBase: string): Buffer {
  const sep = lnurlwBase.includes("?") ? "&" : "?";
  const url = `${lnurlwBase}${sep}p=${"0".repeat(32)}&c=${"0".repeat(16)}`;
  const urlBytes = Buffer.from(url, "utf8");
  const payloadLen = 1 + urlBytes.length;
  const ndefMsg = Buffer.alloc(5 + urlBytes.length);
  ndefMsg[0] = 0xD1;
  ndefMsg[1] = 0x01;
  ndefMsg[2] = payloadLen;
  ndefMsg[3] = 0x55; // 'U'
  ndefMsg[4] = 0x00; // URI identifier
  urlBytes.copy(ndefMsg, 5);
  const file = Buffer.alloc(2 + ndefMsg.length);
  file.writeUInt16BE(ndefMsg.length, 0);
  ndefMsg.copy(file, 2);
  return file;
}

// Compute SDM byte offsets for ChangeFileSettings (ported from ndef.ts).
export function computeSdmOffsets(lnurlwBase: string): { ndefFile: Buffer; encPiccOffset: number; macOffset: number } {
  const ndefFile = buildNdefFile(lnurlwBase);
  const urlStartInFile = 7;
  const sep = lnurlwBase.includes("?") ? "&" : "?";
  const encPiccOffset = urlStartInFile + lnurlwBase.length + sep.length + 2; // "p=" = 2
  const macOffset = encPiccOffset + 32 + 3; // 32 chars + "&c=" = 3
  return { ndefFile, encPiccOffset, macOffset };
}

// Build the SDM file settings payload for ChangeFileSettings (ported from ntag424.ts).
export function buildSdmSettings(encPiccOffset: number, macOffset: number): Buffer {
  const o3 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
  return Buffer.concat([
    Buffer.from([
      0x40, // FileOption: SDM enabled, CommMode=Plain
      0x00, // AR[0]: Change=K0, ReadWrite=K0
      0xE0, // AR[1]: Write=free, Read=K0
      0xC1, // SDMOptions
      0xFF, // SDM AR high
      0x12, // SDM AR low: MetaRead=K1, FileRead=K2
    ]),
    o3(encPiccOffset),
    o3(macOffset),
    o3(macOffset),
  ]);
}

