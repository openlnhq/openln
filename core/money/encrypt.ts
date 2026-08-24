// @ts-nocheck
//
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";

function getKey(): Buffer {
  const secret = process.env.SESSION_SECRET!;
  return Buffer.from(createHash("sha256").update(secret).digest("hex"), "hex");
}

const ALGO = "aes-256-gcm";
const IV_LEN = 16;
const TAG_LEN = 16;

/** Encrypt a UTF-8 string and return a base64-encoded ciphertext (IV + tag + ciphertext). */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/** Decrypt a base64 ciphertext produced by `encrypt()` and return the original UTF-8 string.
 *
 * GCM authentication: `setAuthTag(tag)` is called before `update()` / `final()`.
 * Node.js verifies the 16-byte authentication tag during `final()` and throws
 * an AuthTagMismatch error if the ciphertext has been tampered with.
 * This provides authenticated decryption — no separate MAC step needed.
 */
export function decrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const encrypted = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  // setAuthTag must be called before update/final — GCM tag verified on final()
  decipher.setAuthTag(tag);
  return decipher.update(encrypted).toString("utf8") + decipher.final("utf8");
}
