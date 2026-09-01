import { scryptSync, timingSafeEqual } from "node:crypto";

export function digest(password: string, salt: Buffer): string {
  return `${salt.toString("base64url")}.${scryptSync(password, salt, 32).toString("base64url")}`;
}

export function verify(password: string, stored: string): boolean {
  try {
    const [s, h] = stored.split(".");
    const got = scryptSync(password, Buffer.from(s, "base64url"), 32);
    const want = Buffer.from(h, "base64url");
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}
