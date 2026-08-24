import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { db, entitiesTable, accountsTable } from "../db/index.js";
import { eq } from "drizzle-orm";
export interface Account { id: string; handle: string; createdAt: string }
export interface Session { token: string; account: Account; expiresAt: string }
const TTL_MS = 3 * 60 * 60 * 1000;
const secret = () => process.env.SESSION_SECRET ?? (() => { throw new Error("SESSION_SECRET must be set"); })();
function digest(password: string, salt: Buffer): string { return `${salt.toString("base64url")}.${scryptSync(password, salt, 32).toString("base64url")}`; }
function verify(password: string, stored: string): boolean { try { const [s, h] = stored.split("."); const got = scryptSync(password, Buffer.from(s, "base64url"), 32); const want = Buffer.from(h, "base64url"); return got.length === want.length && timingSafeEqual(got, want); } catch { return false; } }
function sign(value: string): string { return createHmac("sha256", secret()).update(value).digest("base64url"); }
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
    const [account] = await db.select({ id: accountsTable.id }).from(accountsTable).where(eq(accountsTable.entityId, row.id));
    if (!account) throw Error("Account not found");
    return this.newSession({ id: account.id, handle: row.handle, createdAt: row.createdAt.toISOString() });
  }
  async authenticate(token: string): Promise<Account | undefined> {
    try { const [raw, mac] = token.split("."); const expected = sign(raw); if (!raw || !mac || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return undefined; const p = JSON.parse(Buffer.from(raw, "base64url").toString()); return p.exp >= Date.now() ? { id: p.id, handle: p.handle, createdAt: p.createdAt } : undefined; } catch { return undefined; }
  }
  private newSession(account: Account): Session { const expiresAt = new Date(Date.now() + TTL_MS).toISOString(); const raw = Buffer.from(JSON.stringify({ id: account.id, handle: account.handle, createdAt: account.createdAt, exp: Date.parse(expiresAt) })).toString("base64url"); return { token: `${raw}.${sign(raw)}`, account, expiresAt }; }
}
