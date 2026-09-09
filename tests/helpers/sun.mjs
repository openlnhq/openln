import crypto from 'node:crypto';

function aesEcbEncryptBlock(key, block) {
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(block), c.final()]);
}
function shiftLeft1(buf) {
  const out = Buffer.alloc(16, 0); let carry = 0;
  for (let i = 15; i >= 0; i--) { out[i] = ((buf[i] << 1) | carry) & 0xff; carry = (buf[i] & 0x80) ? 1 : 0; }
  return out;
}
function xor16(a, b) { const out = Buffer.alloc(16, 0); for (let i = 0; i < 16; i++) out[i] = a[i] ^ b[i]; return out; }
function generateSubkeys(key) {
  const L = aesEcbEncryptBlock(key, Buffer.alloc(16, 0));
  const msb1 = (L[0] & 0x80) !== 0; const K1 = shiftLeft1(L); if (msb1) K1[15] ^= 0x87;
  const msb2 = (K1[0] & 0x80) !== 0; const K2 = shiftLeft1(K1); if (msb2) K2[15] ^= 0x87;
  return [K1, K2];
}
function aesCmac(key, message) {
  const [K1, K2] = generateSubkeys(key);
  const blockCount = Math.max(1, Math.ceil(message.length / 16));
  let X = Buffer.alloc(16, 0);
  for (let i = 0; i < blockCount - 1; i++) { const block = message.subarray(i * 16, (i + 1) * 16); X = aesEcbEncryptBlock(key, xor16(X, block)); }
  const lastBlock = message.subarray((blockCount - 1) * 16);
  if (lastBlock.length === 16) return aesEcbEncryptBlock(key, xor16(xor16(X, lastBlock), K1));
  const padded = Buffer.alloc(16, 0); lastBlock.copy(padded); padded[lastBlock.length] = 0x80;
  return aesEcbEncryptBlock(key, xor16(xor16(X, padded), K2));
}


export function sunParams(k1Hex,k2Hex,counter=1,uidHex="04010203040506"){
const key1 = Buffer.from(k1Hex, 'hex');
const key2 = Buffer.from(k2Hex, 'hex');
const uid = Buffer.from(uidHex, 'hex');

// plaintext: 0xC7 || UID(7) || ctr(3 LE) || 0x00*5
const plain = Buffer.alloc(16, 0);
plain[0] = 0xc7; uid.copy(plain, 1);
plain.writeUIntLE(counter, 8, 3);

const cipher = crypto.createCipheriv('aes-128-cbc', key1, Buffer.alloc(16, 0));
cipher.setAutoPadding(false);
const p = Buffer.concat([cipher.update(plain), cipher.final()]);

// SV2 = 3C C3 00 01 00 80 || UID(7) || Counter(3)
const ctrBuf = Buffer.alloc(3, 0); ctrBuf.writeUIntLE(counter, 0, 3);
const sv2 = Buffer.alloc(16, 0);
sv2[0] = 0x3c; sv2[1] = 0xc3; sv2[2] = 0x00; sv2[3] = 0x01; sv2[4] = 0x00; sv2[5] = 0x80;
uid.copy(sv2, 6); ctrBuf.copy(sv2, 13);
const sessionMacKey = aesCmac(key2, sv2);
const fullCmac = aesCmac(sessionMacKey, Buffer.alloc(0));
const truncated = Buffer.alloc(8, 0);
for (let i = 0; i < 8; i++) truncated[i] = fullCmac[1 + i * 2];


return {p:p.toString("hex"),c:truncated.toString("hex")};
}
