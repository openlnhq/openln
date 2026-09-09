import bcrypt from "bcryptjs";
import { scryptSync, timingSafeEqual } from "node:crypto";

/** Legacy bitPOS cards use bcrypt; native openLN cards use scrypt. */
export async function verifyCardPin(pin: string, stored: string | null): Promise<boolean> {
  if (!/^[0-9]{4}$/.test(pin) || !stored) return false;
  try {
    if (stored.startsWith("$2")) return await bcrypt.compare(pin, stored);
    const [salt, value, extra] = stored.split(".");
    if (!salt || !value || extra) return false;
    const got = scryptSync(pin, Buffer.from(salt, "base64url"), 32);
    const want = Buffer.from(value, "base64url");
    return got.length === want.length && timingSafeEqual(got, want);
  } catch { return false; }
}
