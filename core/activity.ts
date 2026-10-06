/**
 * Account presence telemetry: last IP / timezone / user agent / seen-at.
 *
 * Written from authenticated app traffic (throttled per account) plus the
 * app-boot POST that carries the browser timezone. Read-only consumer: the
 * admin Userbase console. This module must never throw into a request path.
 */
import type { IncomingMessage } from "node:http";
import { db, accountActivityTable } from "./db/index.js";

const THROTTLE_MS = 60_000;
const lastWrite = new Map<string, number>();

/**
 * The rightmost X-Forwarded-For hop is the nearest proxy-trusted client.
 * Caddy appends the real client IP when it forwards, so an inbound spoofed
 * header stays to the left of the true address; direct connections fall back
 * to the socket address.
 */
export function clientIp(req: IncomingMessage): string | null {
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff.join(",") : String(xff ?? "");
  const chain = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const ip = chain.length ? chain[chain.length - 1] : (req.socket.remoteAddress ?? "");
  return ip ? ip.slice(0, 64) : null;
}

export function sanitizeTimezone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tz = value.trim().slice(0, 64);
  return /^[A-Za-z0-9_+\-/]{1,64}$/.test(tz) ? tz : null;
}

/**
 * Upsert the account's latest presence. Throttled: one write per account per
 * minute unless `force` is set. The timezone is only overwritten when a fresh
 * one is supplied (the events stream does not know it).
 */
export async function touchAccountActivity(
  accountId: string,
  req: IncomingMessage,
  opts: { timezone?: string | null; force?: boolean } = {},
): Promise<void> {
  if (!accountId) return;
  const now = Date.now();
  if (!opts.force) {
    const last = lastWrite.get(accountId) ?? 0;
    if (now - last < THROTTLE_MS) return;
  }
  lastWrite.set(accountId, now);
  const ip = clientIp(req);
  const uaHeader = req.headers["user-agent"];
  const ua = (Array.isArray(uaHeader) ? uaHeader[0] : uaHeader ?? "").slice(0, 200) || null;
  const tz = sanitizeTimezone(opts.timezone);
  try {
    await db
      .insert(accountActivityTable)
      .values({ accountId, lastIp: ip, lastUserAgent: ua, lastTimezone: tz })
      .onConflictDoUpdate({
        target: accountActivityTable.accountId,
        set: {
          lastIp: ip,
          lastUserAgent: ua,
          lastSeenAt: new Date(),
          ...(tz ? { lastTimezone: tz } : {}),
        },
      });
  } catch {
    /* presence telemetry must never break a request */
  }
}

/** Record only the timezone (app boot). Does not touch the seen-at clock. */
export async function recordActivityTimezone(accountId: string, timezone: unknown): Promise<void> {
  const tz = sanitizeTimezone(timezone);
  if (!accountId || !tz) return;
  try {
    await db
      .insert(accountActivityTable)
      .values({ accountId, lastTimezone: tz })
      .onConflictDoUpdate({ target: accountActivityTable.accountId, set: { lastTimezone: tz } });
  } catch {
    /* ignore */
  }
}
