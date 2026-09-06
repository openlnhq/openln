import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { db, entitiesTable, accountsTable, deviceTokensTable } from "../db/index.js";
import { eq, and, isNull } from "drizzle-orm";
export interface Account { id: string; handle: string; createdAt: string }
export interface Session { token: string; account: Account; expiresAt: string }
const TTL_MS = 3 * 60 * 60 * 1000;
const secret = () => process.env.SESSION_SECRET ?? (() => { throw new Error("SESSION_SECRET must be set"); })();
function digest(password: string, salt: Buffer): string { return `${salt.toString("base64url")}.${scryptSync(password, salt, 32).toString("base64url")}`; }

/**
 * Legacy identity consolidation (2026-09-02): entities migrated from
 * bitpos_dev (bcrypt, $2 prefix, 60 chars) and maekob (scrypt, hex
 * "salt:key" with a 64-byte key) carry their ORIGINAL hash verbatim —
 * never re-hashed blind, since the plaintext is never known. verify()
 * detects format by shape and checks against the matching algorithm.
 * On a successful legacy-format login, the caller re-hashes to openLN's
 * native format (migrate-on-login) so accounts converge over time without
 * ever forcing a password reset.
 */
type HashFormat = "native" | "bcrypt" | "maekob-scrypt";
function detectFormat(stored: string): HashFormat {
  if (stored.startsWith("$2")) return "bcrypt";
  if (/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(stored)) return "maekob-scrypt";
  return "native";
}
function verify(password: string, stored: string): boolean {
  const fmt = detectFormat(stored);
  try {
    if (fmt === "bcrypt") return bcrypt.compareSync(password, stored);
    if (fmt === "maekob-scrypt") {
      const [salt, key] = stored.split(":");
      const got = scryptSync(password, Buffer.from(salt, "hex"), 64);
      const want = Buffer.from(key, "hex");
      return got.length === want.length && timingSafeEqual(got, want);
    }
    const [s, h] = stored.split(".");
    const got = scryptSync(password, Buffer.from(s, "base64url"), 32);
    const want = Buffer.from(h, "base64url");
    return got.length === want.length && timingSafeEqual(got, want);
  } catch { return false; }
}
function sign(value: string): string { return createHmac("sha256", secret()).update(value).digest("base64url"); }

/**
 * RIC/CYD devices authenticate with a raw 64-char hex device token (from
 * device_tokens, issued via POST /api/accounts/:id/device-tokens and written
 * to the device over BLE) instead of a session token. Ported verbatim from
 * bitPOS's middleware/auth.ts tryDeviceToken — ONLY reached when the session
 * HMAC parse fails, so this never shadows real user sessions.
 */
async function tryDeviceToken(rawToken: string): Promise<Account | undefined> {
  if (!/^[0-9a-f]{64}$/.test(rawToken)) return undefined;
  const [row] = await db.select({ id: deviceTokensTable.id, accountId: deviceTokensTable.accountId, handle: entitiesTable.handle, entityCreatedAt: entitiesTable.createdAt })
    .from(deviceTokensTable)
    .innerJoin(accountsTable, eq(accountsTable.id, deviceTokensTable.accountId))
    .innerJoin(entitiesTable, eq(entitiesTable.id, accountsTable.entityId))
    .where(and(eq(deviceTokensTable.token, rawToken), isNull(deviceTokensTable.revokedAt)));
  if (!row) return undefined;
  db.update(deviceTokensTable).set({ lastUsedAt: new Date() }).where(eq(deviceTokensTable.id, row.id)).catch(() => {});
  return { id: row.accountId, handle: row.handle, createdAt: row.entityCreatedAt.toISOString() };
}

export class AuthService {
  async register(handle: string, password: string): Promise<Session> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}$/.test(handle)) throw Error("Invalid handle");
    if (password.length < 12) throw Error("Password must be at least 12 characters");
    const k = handle.toLowerCase();
    const [existing] = await db.select({ id: entitiesTable.id }).from(entitiesTable).where(eq(entitiesTable.handle, k));
    if (existing) throw Error("Handle already taken");
    const [entity] = await db.insert(entitiesTable).values({ id: randomUUID(), handle: k, pinHash: "password-login", passwordHash: digest(password, randomBytes(16)) }).returning({ id: entitiesTable.id, handle: entitiesTable.handle, createdAt: entitiesTable.createdAt });
    const [account] = await db.insert(accountsTable).values({ entityId: entity.id, walletMode: "unset" }).returning({ id: accountsTable.id });
    return this.newSession({ id: account.id, handle: entity.handle, createdAt: entity.createdAt.toISOString() });
  }
  async login(handle: string, password: string): Promise<Session> {
    const [row] = await db.select({ id: entitiesTable.id, handle: entitiesTable.handle, createdAt: entitiesTable.createdAt, passwordHash: entitiesTable.passwordHash }).from(entitiesTable).where(eq(entitiesTable.handle, handle.toLowerCase()));
    if (!row || !row.passwordHash || !verify(password, row.passwordHash)) throw Error("Invalid handle or password");
    if (detectFormat(row.passwordHash) !== "native") {
      db.update(entitiesTable).set({ passwordHash: digest(password, randomBytes(16)) }).where(eq(entitiesTable.id, row.id)).catch(() => {});
    }
    const [account] = await db.select({ id: accountsTable.id }).from(accountsTable).where(eq(accountsTable.entityId, row.id));
    if (!account) throw Error("Account not found");
    return this.newSession({ id: account.id, handle: row.handle, createdAt: row.createdAt.toISOString() });
  }
  /**
   * Ported verbatim (semantics) from bitPOS's /auth/access-state: tells the
   * client which credential step a handle needs, without leaking account
   * data. legacyPin=true means the entity was migrated in with a bitPOS PIN
   * and no password yet — the client should route to migrate-password.
   */
  async accessState(handle: string): Promise<{ exists: boolean; passwordSet: boolean; legacyPin: boolean }> {
    const [row] = await db.select({ passwordHash: entitiesTable.passwordHash, pinHash: entitiesTable.pinHash }).from(entitiesTable).where(eq(entitiesTable.handle, handle.toLowerCase()));
    return { exists: Boolean(row), passwordSet: Boolean(row?.passwordHash), legacyPin: Boolean(row && !row.passwordHash) };
  }
  /**
   * Ported verbatim from bitPOS's /auth/migrate-password: the bitPOS PIN
   * (bcrypt-hashed in pinHash, untouched by this migration) proves ownership
   * once, then a real password becomes the login credential going forward.
   * The PIN itself is left in place for in-app sensitive-action re-auth.
   */
  async migratePassword(handle: string, pin: string, password: string): Promise<Session> {
    if (password.length < 12) throw Error("Password must be at least 12 characters");
    const [row] = await db.select({ id: entitiesTable.id, handle: entitiesTable.handle, createdAt: entitiesTable.createdAt, passwordHash: entitiesTable.passwordHash, pinHash: entitiesTable.pinHash }).from(entitiesTable).where(eq(entitiesTable.handle, handle.toLowerCase()));
    if (!row || row.passwordHash || !row.pinHash || !bcrypt.compareSync(pin, row.pinHash)) throw Error("Invalid credentials");
    await db.update(entitiesTable).set({ passwordHash: digest(password, randomBytes(16)) }).where(eq(entitiesTable.id, row.id));
    const [account] = await db.select({ id: accountsTable.id }).from(accountsTable).where(eq(accountsTable.entityId, row.id));
    if (!account) throw Error("Account not found");
    return this.newSession({ id: account.id, handle: row.handle, createdAt: row.createdAt.toISOString() });
  }
  async authenticate(token: string): Promise<Account | undefined> {
    try { const [raw, mac] = token.split("."); const expected = sign(raw); if (!raw || !mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return await tryDeviceToken(token); const p = JSON.parse(Buffer.from(raw, "base64url").toString()); return p.exp >= Date.now() ? { id: p.id, handle: p.handle, createdAt: p.createdAt } : undefined; } catch { return await tryDeviceToken(token); }
  }
  /**
   * Cross-subdomain handoff, same pattern as bitpos.app -> maekob.com's
   * proven /shop/embed-token + /auth/embed: a short-lived (8 min) signed
   * token carrying only a handle + issuer + expiry, separate namespace from
   * real session tokens (prefixed "embed:" before signing so a leaked embed
   * token can never be replayed as a real session token, and vice versa).
   * No shared secret needed here since both sides are the same process, but
   * kept as a distinct, narrow-purpose token by design, not the raw session.
   */
  embedToken(account: Account): string {
    const exp = Date.now() + 8 * 60 * 1000;
    const raw = Buffer.from(JSON.stringify({ id: account.id, handle: account.handle, iss: "openln-embed", exp })).toString("base64url");
    return `${raw}.${sign("embed:" + raw)}`;
  }
  async sessionForEmbedToken(embedToken: string): Promise<Session | undefined> {
    try {
      const [raw, mac] = embedToken.split(".");
      const expected = sign("embed:" + raw);
      if (!raw || !mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return undefined;
      const p = JSON.parse(Buffer.from(raw, "base64url").toString());
      if (p.iss !== "openln-embed" || !p.exp || p.exp < Date.now()) return undefined;
      const [row] = await db.select({ id: entitiesTable.id, handle: entitiesTable.handle, createdAt: entitiesTable.createdAt }).from(entitiesTable).where(eq(entitiesTable.handle, String(p.handle).toLowerCase()));
      if (!row) return undefined;
      const [account] = await db.select({ id: accountsTable.id }).from(accountsTable).where(eq(accountsTable.entityId, row.id));
      if (!account || account.id !== p.id) return undefined;
      return this.newSession({ id: account.id, handle: row.handle, createdAt: row.createdAt.toISOString() });
    } catch { return undefined; }
  }
  private newSession(account: Account): Session { const expiresAt = new Date(Date.now() + TTL_MS).toISOString(); const raw = Buffer.from(JSON.stringify({ id: account.id, handle: account.handle, createdAt: account.createdAt, exp: Date.parse(expiresAt) })).toString("base64url"); return { token: `${raw}.${sign(raw)}`, account, expiresAt }; }
}
