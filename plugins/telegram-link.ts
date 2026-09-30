/**
 * Telegram account linking. Support runs through @openLN_bot: a Telegram user
 * connects to their openLN account in the app (Settings, Telegram support),
 * redeems the code here, and from then on the bot relays their messages with
 * the account attached. This module mints and redeems those links.
 *
 *   POST /api/telegram/link-code   (session)  mint a single-use connect code
 *   GET  /api/telegram/status      (session)  the link for this account, if any
 *   POST /api/telegram/unlink      (session)  remove the link
 *   POST /api/telegram/claim       (bot)      redeem a code for a Telegram user
 *
 * claim is called server-to-server by the support bot and is gated by the
 * TELEGRAM_LINK_SECRET header (shared with the bot), not a browser session:
 * the code itself is the proof of account control, and it is only ever shown
 * inside the signed-in app. Codes expire after 15 minutes and are single-use.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { db, accountsTable, entitiesTable, telegramLinkCodesTable, telegramLinksTable } from "../core/db/index.js";

const json = (r: ServerResponse, s: number, b: unknown) => { r.writeHead(s, { "content-type": "application/json" }); r.end(JSON.stringify(b)); return true; };
async function body(req: IncomingMessage): Promise<Record<string, unknown>> { let raw = ""; for await (const c of req) raw += c; return raw ? JSON.parse(raw) : {}; }

// Codes get typed by hand from the app screen; skip look-alike characters.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;
const CODE_TTL_MS = 15 * 60 * 1000;

function newCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function botSecretOk(req: IncomingMessage): boolean {
  const secret = process.env.TELEGRAM_LINK_SECRET ?? "";
  const given = String(req.headers["x-openln-bot-secret"] ?? "");
  if (!secret || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handleTelegramLinkRoute(req: IncomingMessage, res: ServerResponse, u: URL, account: { id: string } | undefined): Promise<boolean> {
  if (!u.pathname.startsWith("/api/telegram/")) return false;

  // Bot-to-server: redeem a connect code. No browser session here; the shared
  // secret authenticates the caller, the code identifies the account.
  if (req.method === "POST" && u.pathname === "/api/telegram/claim") {
    if (!process.env.TELEGRAM_LINK_SECRET) return json(res, 503, { error: "Telegram linking is not configured on this server" });
    if (!botSecretOk(req)) return json(res, 403, { error: "forbidden" });
    let v: Record<string, unknown>;
    try { v = await body(req); } catch { return json(res, 400, { error: "invalid_request" }); }
    const code = String(v.code ?? "").trim().toUpperCase();
    const telegramUserId = Number(v.telegram_user_id);
    if (!CODE_RE.test(code) || !Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) return json(res, 400, { error: "invalid_code" });
    const username = String(v.username ?? "").slice(0, 64) || null;
    const firstName = String(v.first_name ?? "").slice(0, 128) || null;

    const [row] = await db.select().from(telegramLinkCodesTable).where(eq(telegramLinkCodesTable.code, code));
    if (!row || row.expiresAt.getTime() < Date.now()) return json(res, 400, { error: "invalid_code" });

    const [entity] = await db.select({ id: entitiesTable.id, handle: entitiesTable.handle }).from(entitiesTable).where(eq(entitiesTable.id, row.entityId));
    if (!entity) return json(res, 400, { error: "invalid_code" });

    if (row.usedAt) {
      // Idempotent double-submit: same code, same Telegram user, already linked.
      const [existing] = await db.select().from(telegramLinksTable).where(eq(telegramLinksTable.entityId, entity.id));
      if (existing && Number(existing.telegramUserId) === telegramUserId) return json(res, 200, { ok: true, handle: entity.handle });
      return json(res, 400, { error: "invalid_code" });
    }

    const [taken] = await db.select({ entityId: telegramLinksTable.entityId }).from(telegramLinksTable).where(eq(telegramLinksTable.telegramUserId, telegramUserId));
    if (taken && taken.entityId !== entity.id) return json(res, 409, { error: "telegram_already_linked" });

    // One Telegram per account: a fresh connect replaces the previous one.
    await db.delete(telegramLinksTable).where(eq(telegramLinksTable.entityId, entity.id));
    await db.insert(telegramLinksTable).values({ entityId: entity.id, telegramUserId, username, firstName });
    await db.update(telegramLinkCodesTable).set({ usedAt: new Date() }).where(eq(telegramLinkCodesTable.code, code));
    return json(res, 200, { ok: true, handle: entity.handle, username });
  }

  if (!account) return json(res, 401, { error: "Authentication required" });
  const [acc] = await db.select({ entityId: accountsTable.entityId }).from(accountsTable).where(eq(accountsTable.id, account.id));
  if (!acc) return json(res, 404, { error: "Account not found" });

  if (req.method === "POST" && u.pathname === "/api/telegram/link-code") {
    if (!process.env.TELEGRAM_LINK_SECRET) return json(res, 503, { error: "Telegram linking is not configured on this server" });
    // Retire day-old codes so the table stays tiny.
    await db.delete(telegramLinkCodesTable).where(lt(telegramLinkCodesTable.expiresAt, new Date(Date.now() - 24 * 60 * 60 * 1000)));
    let code = "";
    for (let i = 0; i < 6 && !code; i++) {
      const candidate = newCode();
      const [dup] = await db.select({ code: telegramLinkCodesTable.code }).from(telegramLinkCodesTable).where(eq(telegramLinkCodesTable.code, candidate));
      if (!dup) code = candidate;
    }
    if (!code) return json(res, 500, { error: "Could not allocate a code, try again" });
    await db.insert(telegramLinkCodesTable).values({ code, entityId: acc.entityId, expiresAt: new Date(Date.now() + CODE_TTL_MS) });
    return json(res, 200, { code, url: `https://t.me/openLN_bot?start=link_${code}`, expiresInSeconds: CODE_TTL_MS / 1000 });
  }

  if (req.method === "GET" && u.pathname === "/api/telegram/status") {
    const [entity] = await db.select({ handle: entitiesTable.handle }).from(entitiesTable).where(eq(entitiesTable.id, acc.entityId));
    const [link] = await db.select().from(telegramLinksTable).where(eq(telegramLinksTable.entityId, acc.entityId));
    if (!link) return json(res, 200, { linked: false, handle: entity?.handle ?? null });
    return json(res, 200, { linked: true, handle: entity?.handle ?? null, username: link.username, firstName: link.firstName, linkedAt: link.linkedAt });
  }

  if (req.method === "POST" && u.pathname === "/api/telegram/unlink") {
    await db.delete(telegramLinksTable).where(eq(telegramLinksTable.entityId, acc.entityId));
    return json(res, 200, { ok: true });
  }

  return false;
}
