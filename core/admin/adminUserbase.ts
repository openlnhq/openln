/**
 * Admin Userbase API - customer situational-awareness console.
 *
 * Auth: the same admin gate as the treasury console (./adminAuth.js): the
 * X-Admin-Secret header or a session whose handle is in ADMIN_HANDLES.
 * Read-only: nothing here mutates merchant state.
 *
 * Routes:
 *   GET /api/admin/userbase?q=            list: every account with rollups
 *                                         (wallets, RIC fleet, cards, payments,
 *                                         support link, presence)
 *   GET /api/admin/userbase/balances?ids= live balance sweep, bounded id set
 *   GET /api/admin/userbase/:accountId    full detail bundle for one account
 *   GET /api/admin/userbase/:id/balances  live balances for one account
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import {
  db,
  accountsTable,
  entitiesTable,
  accountConnectionsTable,
  cardsTable,
  deviceTokensTable,
  ricDeviceTelemetryTable,
  transactionsTable,
  pendingInvoicesTable,
  telegramLinksTable,
  accountActivityTable,
} from "../db/index.js";
import { and, or, eq, desc, sql, ilike, inArray, type SQL } from "drizzle-orm";
import { isAdmin, type AdminSessionAccount } from "./adminAuth.js";
import { getBalance, resolveNwcUrl } from "../money/nwc.js";
import { blinkGetBalance } from "../money/blink.js";

const json = (r: ServerResponse, s: number, b: unknown): true => {
  r.writeHead(s, { "content-type": "application/json" });
  r.end(JSON.stringify(b));
  return true;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A RIC pings roughly every 5 minutes when idle; 7 minutes means "online". */
const ONLINE_WINDOW_MS = 7 * 60 * 1000;
/** Live balance reads: hard cap per read so one dead wallet cannot stall a page. */
const BALANCE_TIMEOUT_MS = 6000;

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timed out after " + Math.round(ms / 1000) + "s")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ---------------------------------------------------------------------------
// Support bot stats (read-only peek at the relay bot's sqlite). The bot lives
// on the prod host only; on any other host (dev) this degrades to null.
// ---------------------------------------------------------------------------
type BotUser = { relays: number; lastSeen: string | null; blocked: boolean; verified: boolean };
let botCache: { at: number; rows: Map<number, BotUser> } | null = null;

const nodeRequire = createRequire(import.meta.url);

function botStats(): Map<number, BotUser> | null {
  const file = process.env.OPENLN_SUPPORT_DB || "/opt/openln-support/state/support.db";
  if (botCache && Date.now() - botCache.at < 20_000) return botCache.rows;
  try {
    if (!existsSync(file)) return null;
    const { DatabaseSync } = nodeRequire("node:sqlite") as {
      DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
        prepare(sql: string): { all(): Array<Record<string, unknown>> };
        close(): void;
      };
    };
    const dbx = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = dbx.prepare("select user_id, relay_count, last_seen, blocked, verified from users").all();
      const map = new Map<number, BotUser>();
      for (const r of rows) {
        map.set(Number(r.user_id), {
          relays: Number(r.relay_count ?? 0),
          lastSeen: r.last_seen == null ? null : String(r.last_seen),
          blocked: Number(r.blocked ?? 0) === 1,
          verified: Number(r.verified ?? 0) === 1,
        });
      }
      botCache = { at: Date.now(), rows: map };
      return map;
    } finally {
      try { dbx.close(); } catch { /* ignore */ }
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------
const uuidList = (raw: string | null): string[] =>
  String(raw ?? "").split(",").map((s) => s.trim()).filter((s) => UUID_RE.test(s)).slice(0, 12);

type ConnRow = { id: string; accountId: string; kind: string; mode: string | null; label: string | null; createdAt: Date; lightningAddress: string | null; clinkPointer: string | null };
type DeviceRow = {
  id: string; accountId: string; label: string; mac: string | null;
  revokedAt: Date | null; lastUsedAt: Date | null; createdAt: Date;
  firmwareVersion: string | null; board: string | null; bootId: string | null; uptimeMs: number | null;
  runningPartition: string | null; lastSeenAt: Date | null; lastHelloAt: Date | null;
  rssi: number | null; resetReason: string | null; bootCount: number | null;
  wifiDrops: number | null; wifiDropsTotal: number | null;
  otaState: string | null; otaCode: string | null; otaTargetVersion: string | null;
};

function devicePublic(d: DeviceRow, now: number) {
  const seen = Math.max(d.lastSeenAt ? d.lastSeenAt.getTime() : 0, d.lastUsedAt ? d.lastUsedAt.getTime() : 0);
  const lastActivityAt = seen ? new Date(seen).toISOString() : null;
  const online = !d.revokedAt && seen > now - ONLINE_WINDOW_MS;
  return {
    id: d.id, label: d.label, mac: d.mac, revokedAt: d.revokedAt, createdAt: d.createdAt,
    firmwareVersion: d.firmwareVersion, board: d.board, runningPartition: d.runningPartition,
    bootId: d.bootId, uptimeMs: d.uptimeMs, lastSeenAt: d.lastSeenAt, lastHelloAt: d.lastHelloAt,
    // Health telemetry (firmware 1.0.15+): signal, restart cause, lifetime counters.
    rssi: d.rssi, resetReason: d.resetReason, bootCount: d.bootCount,
    wifiDrops: d.wifiDrops, wifiDropsTotal: d.wifiDropsTotal,
    bootedAtApprox: (d.uptimeMs != null && seen) ? new Date(seen - d.uptimeMs).toISOString() : null,
    ota: d.otaState === null ? null : { state: d.otaState, code: d.otaCode, targetVersion: d.otaTargetVersion },
    online, lastActivityAt,
  };
}

function connRoles(a: { defaultConnectionId: string | null; ricConnectionId: string | null; cardsConnectionId: string | null; ricReceiveConnectionId: string | null; ricSendConnectionId: string | null; cardsReceiveConnectionId: string | null; cardsSendConnectionId: string | null }, id: string): string[] {
  const roles: string[] = [];
  if (a.defaultConnectionId === id) roles.push("default");
  if (a.ricConnectionId === id || a.ricReceiveConnectionId === id || a.ricSendConnectionId === id) roles.push("RIC");
  if (a.cardsConnectionId === id || a.cardsReceiveConnectionId === id || a.cardsSendConnectionId === id) roles.push("Cards");
  return roles;
}

async function loadRollups(accountIds: string[]) {
  const conns = await db.select({
    id: accountConnectionsTable.id, accountId: accountConnectionsTable.accountId,
    kind: accountConnectionsTable.kind, mode: accountConnectionsTable.mode, label: accountConnectionsTable.label,
    createdAt: accountConnectionsTable.createdAt, lightningAddress: accountConnectionsTable.lightningAddress,
    clinkPointer: accountConnectionsTable.clinkPointer,
  }).from(accountConnectionsTable).where(inArray(accountConnectionsTable.accountId, accountIds)).orderBy(accountConnectionsTable.createdAt, accountConnectionsTable.id);

  const devices = await db.select({
    id: deviceTokensTable.id, accountId: deviceTokensTable.accountId, label: deviceTokensTable.label,
    mac: deviceTokensTable.mac, revokedAt: deviceTokensTable.revokedAt, lastUsedAt: deviceTokensTable.lastUsedAt,
    createdAt: deviceTokensTable.createdAt,
    firmwareVersion: ricDeviceTelemetryTable.firmwareVersion, board: ricDeviceTelemetryTable.board,
    bootId: ricDeviceTelemetryTable.bootId, uptimeMs: ricDeviceTelemetryTable.uptimeMs,
    runningPartition: ricDeviceTelemetryTable.runningPartition, lastSeenAt: ricDeviceTelemetryTable.lastSeenAt,
    rssi: ricDeviceTelemetryTable.rssi, resetReason: ricDeviceTelemetryTable.resetReason,
    bootCount: ricDeviceTelemetryTable.bootCount, wifiDrops: ricDeviceTelemetryTable.wifiDrops,
    wifiDropsTotal: ricDeviceTelemetryTable.wifiDropsTotal,
    lastHelloAt: ricDeviceTelemetryTable.lastHelloAt, otaState: ricDeviceTelemetryTable.otaState,
    otaCode: ricDeviceTelemetryTable.otaCode, otaTargetVersion: ricDeviceTelemetryTable.otaTargetVersion,
  }).from(deviceTokensTable).leftJoin(ricDeviceTelemetryTable, eq(ricDeviceTelemetryTable.deviceTokenId, deviceTokensTable.id))
    .where(inArray(deviceTokensTable.accountId, accountIds)).orderBy(deviceTokensTable.createdAt, deviceTokensTable.id);

  const cards = await db.select({
    id: cardsTable.id, accountId: cardsTable.accountId, status: cardsTable.status,
    name: cardsTable.name, uid: cardsTable.uid, lastUsedAt: cardsTable.lastUsedAt, createdAt: cardsTable.createdAt,
  }).from(cardsTable).where(inArray(cardsTable.accountId, accountIds)).orderBy(cardsTable.createdAt, cardsTable.id);

  const txAgg = await db.select({
    accountId: transactionsTable.accountId,
    txCount: sql<number>`(count(*))::int`,
    inCount: sql<number>`(count(*) filter (where ${transactionsTable.direction} = 'in'))::int`,
    outCount: sql<number>`(count(*) filter (where ${transactionsTable.direction} = 'out'))::int`,
    inVolumeSats: sql<number>`coalesce((sum(${transactionsTable.amountSats}) filter (where ${transactionsTable.direction} = 'in' and ${transactionsTable.status} = 'completed')), 0)::float8`,
    outVolumeSats: sql<number>`coalesce((sum(${transactionsTable.amountSats}) filter (where ${transactionsTable.direction} = 'out' and ${transactionsTable.status} = 'completed')), 0)::float8`,
    failedCount: sql<number>`(count(*) filter (where ${transactionsTable.status} = 'failed'))::int`,
    lastTxAt: sql<Date | null>`max(${transactionsTable.createdAt})`,
  }).from(transactionsTable).where(inArray(transactionsTable.accountId, accountIds)).groupBy(transactionsTable.accountId);

  const wrapAgg = await db.select({
    accountId: pendingInvoicesTable.accountId,
    wrapsTotal: sql<number>`(count(*))::int`,
    settledCount: sql<number>`(count(*) filter (where ${pendingInvoicesTable.wrapStatus} = 'settled'))::int`,
    settledSats: sql<number>`coalesce((sum(${pendingInvoicesTable.amountSats}) filter (where ${pendingInvoicesTable.wrapStatus} = 'settled')), 0)::float8`,
    openCount: sql<number>`(count(*) filter (where ${pendingInvoicesTable.wrapStatus} not in ('settled', 'cancelled')))::int`,
    stuckCount: sql<number>`(count(*) filter (where ${pendingInvoicesTable.wrapStatus} = 'needs_reconciliation'))::int`,
    lastWrapAt: sql<Date | null>`max(${pendingInvoicesTable.createdAt})`,
  }).from(pendingInvoicesTable).where(inArray(pendingInvoicesTable.accountId, accountIds)).groupBy(pendingInvoicesTable.accountId);

  const entityIds = await db.select({ entityId: accountsTable.entityId }).from(accountsTable).where(inArray(accountsTable.id, accountIds));
  const tgs = entityIds.length
    ? await db.select({
        entityId: telegramLinksTable.entityId, username: telegramLinksTable.username, firstName: telegramLinksTable.firstName,
        linkedAt: telegramLinksTable.linkedAt, telegramUserId: telegramLinksTable.telegramUserId,
      }).from(telegramLinksTable).where(inArray(telegramLinksTable.entityId, entityIds.map((r) => r.entityId)))
    : [];

  return { conns, devices, cards, txAgg, wrapAgg, tgs };
}

function buildAccountRow(
  a: {
    accountId: string; entityId: string; handle: string; email: string | null; phone: string | null;
    businessName: string | null; type: string; currency: string; createdAt: Date;
    defaultConnectionId: string | null; ricConnectionId: string | null; cardsConnectionId: string | null;
    ricReceiveConnectionId: string | null; ricSendConnectionId: string | null;
    cardsReceiveConnectionId: string | null; cardsSendConnectionId: string | null;
    lastIp: string | null; lastTimezone: string | null; lastUserAgent: string | null;
    lastSeenAt: Date | null; firstSeenAt: Date | null;
  },
  R: Awaited<ReturnType<typeof loadRollups>>,
  bot: Map<number, BotUser> | null,
  now: number,
) {
  const myConns = R.conns.filter((c) => c.accountId === a.accountId) as ConnRow[];
  const myDevices = R.devices.filter((d) => d.accountId === a.accountId) as DeviceRow[];
  const myCards = R.cards.filter((c) => c.accountId === a.accountId);
  const tx = R.txAgg.find((t) => t.accountId === a.accountId);
  const wrap = R.wrapAgg.find((w) => w.accountId === a.accountId);
  const tg = R.tgs.find((t) => t.entityId === a.entityId) ?? null;
  const bs = tg && bot ? bot.get(Number(tg.telegramUserId)) ?? null : null;

  const kinds = { nwc: 0, blink: 0, lnaddress: 0, clink: 0 } as Record<string, number>;
  for (const c of myConns) if (c.kind in kinds) kinds[c.kind] += 1;

  const active = myDevices.filter((d) => !d.revokedAt);
  const devices = myDevices.map((d) => devicePublic(d, now));
  const lastDeviceAt = devices.reduce<number>((m, d) => Math.max(m, d.lastActivityAt ? Date.parse(d.lastActivityAt) : 0), 0);

  return {
    id: a.accountId,
    entityId: a.entityId,
    handle: a.handle,
    businessName: a.businessName,
    type: a.type,
    currency: a.currency,
    createdAt: a.createdAt,
    email: a.email,
    phone: a.phone,
    wallets: {
      count: myConns.length,
      kinds,
      list: myConns.map((c) => ({ id: c.id, kind: c.kind, mode: c.mode, label: c.label, createdAt: c.createdAt, roles: connRoles(a, c.id) })),
    },
    ric: {
      total: myDevices.length,
      active: active.length,
      online: devices.filter((d) => d.online).length,
      revoked: myDevices.length - active.length,
      lastActivityAt: lastDeviceAt ? new Date(lastDeviceAt).toISOString() : null,
      devices: devices.map((d) => ({ id: d.id, label: d.label, revoked: !!d.revokedAt, online: d.online, lastActivityAt: d.lastActivityAt, firmwareVersion: d.firmwareVersion })),
    },
    cards: {
      total: myCards.length,
      active: myCards.filter((c) => c.status === "active").length,
      frozen: myCards.filter((c) => c.status === "frozen").length,
      cancelled: myCards.filter((c) => c.status === "cancelled").length,
      lastUsedAt: myCards.reduce<Date | null>((m, c) => (c.lastUsedAt && (!m || c.lastUsedAt > m) ? c.lastUsedAt : m), null),
    },
    payments: {
      txCount: tx?.txCount ?? 0,
      inCount: tx?.inCount ?? 0,
      outCount: tx?.outCount ?? 0,
      inVolumeSats: Math.round(tx?.inVolumeSats ?? 0),
      outVolumeSats: Math.round(tx?.outVolumeSats ?? 0),
      failedCount: tx?.failedCount ?? 0,
      lastTxAt: tx?.lastTxAt ?? null,
      wrapsSettled: wrap?.settledCount ?? 0,
      wrapsSettledSats: Math.round(wrap?.settledSats ?? 0),
      wrapsOpen: wrap?.openCount ?? 0,
      wrapsStuck: wrap?.stuckCount ?? 0,
      lastWrapAt: wrap?.lastWrapAt ?? null,
    },
    support: tg
      ? {
          linked: true, username: tg.username, firstName: tg.firstName, linkedAt: tg.linkedAt,
          messages: bs?.relays ?? null, lastAt: bs?.lastSeen ?? null, blocked: bs?.blocked ?? false, verified: bs?.verified ?? false,
        }
      : { linked: false, username: null, firstName: null, linkedAt: null, messages: null, lastAt: null, blocked: false, verified: false },
    activity: {
      lastSeenAt: a.lastSeenAt, firstSeenAt: a.firstSeenAt, lastIp: a.lastIp, lastTimezone: a.lastTimezone, userAgent: a.lastUserAgent,
    },
  };
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------
async function readConnectionBalance(row: { kind: string; nwcUrlEncrypted: string | null; blinkApiKeyEncrypted: string | null; blinkWalletId: string | null }): Promise<{ ok: boolean; balanceSats?: number; error?: string }> {
  try {
    if (row.kind === "nwc") {
      const url = resolveNwcUrl(row.nwcUrlEncrypted);
      if (!url) return { ok: false, error: "No NWC connection string stored" };
      const r = await raceTimeout(getBalance(url), BALANCE_TIMEOUT_MS);
      return { ok: true, balanceSats: r.balanceSats };
    }
    if (row.kind === "blink") {
      const key = resolveNwcUrl(row.blinkApiKeyEncrypted);
      if (!key || !row.blinkWalletId) return { ok: false, error: "Incomplete Blink credentials" };
      const r = await raceTimeout(blinkGetBalance(key, row.blinkWalletId), BALANCE_TIMEOUT_MS);
      return { ok: true, balanceSats: r.balanceSats };
    }
    if (row.kind === "lnaddress") return { ok: false, error: "Lightning Address lane is receive-only; no wallet balance to read" };
    return { ok: false, error: "This lane does not expose a wallet balance" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Balance read failed" };
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function handleAdminUserbaseRoute(req: IncomingMessage, res: ServerResponse, u: URL, sessionAccount: AdminSessionAccount): Promise<boolean> {
  if (!u.pathname.startsWith("/api/admin/userbase")) return false;
  if (!(await isAdmin(req, sessionAccount))) return json(res, 403, { error: "Admin access required" });
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });

  const rest = u.pathname.slice("/api/admin/userbase".length).replace(/^\//, "");
  const now = Date.now();

  // ---- list ----
  if (!rest) {
    const q = (u.searchParams.get("q") ?? "").trim().slice(0, 80);
    const limit = Math.min(Math.max(Number(u.searchParams.get("limit") ?? 100) || 100, 1), 200);
    const offset = Math.max(Number(u.searchParams.get("offset") ?? 0) || 0, 0);
    const pat = "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
    const where: SQL | undefined = and(
      eq(entitiesTable.isSystem, false),
      q
        ? or(ilike(entitiesTable.handle, pat), ilike(entitiesTable.email, pat), ilike(entitiesTable.phone, pat), ilike(accountsTable.businessName, pat))
        : undefined,
    );
    const sel = {
      accountId: accountsTable.id, entityId: accountsTable.entityId, handle: entitiesTable.handle,
      email: entitiesTable.email, phone: entitiesTable.phone, businessName: accountsTable.businessName,
      type: accountsTable.type, currency: accountsTable.currency, createdAt: accountsTable.createdAt,
      defaultConnectionId: accountsTable.defaultConnectionId, ricConnectionId: accountsTable.ricConnectionId,
      cardsConnectionId: accountsTable.cardsConnectionId, ricReceiveConnectionId: accountsTable.ricReceiveConnectionId,
      ricSendConnectionId: accountsTable.ricSendConnectionId, cardsReceiveConnectionId: accountsTable.cardsReceiveConnectionId,
      cardsSendConnectionId: accountsTable.cardsSendConnectionId,
      lastIp: accountActivityTable.lastIp, lastTimezone: accountActivityTable.lastTimezone,
      lastUserAgent: accountActivityTable.lastUserAgent, lastSeenAt: accountActivityTable.lastSeenAt,
      firstSeenAt: accountActivityTable.firstSeenAt,
    };
    try {
      const rows = await db.select(sel).from(accountsTable)
        .innerJoin(entitiesTable, eq(accountsTable.entityId, entitiesTable.id))
        .leftJoin(accountActivityTable, eq(accountActivityTable.accountId, accountsTable.id))
        .where(where)
        .orderBy(desc(sql`coalesce(${accountActivityTable.lastSeenAt}, ${accountsTable.createdAt})`))
        .limit(limit).offset(offset);
      const [{ n: total }] = await db.select({ n: sql<number>`(count(*))::int` }).from(accountsTable)
        .innerJoin(entitiesTable, eq(accountsTable.entityId, entitiesTable.id)).where(where);
      const ids = rows.map((r) => r.accountId);
      const R = ids.length
        ? await loadRollups(ids)
        : { conns: [], devices: [], cards: [], txAgg: [], wrapAgg: [], tgs: [] };
      const bot = botStats();
      return json(res, 200, { total, limit, offset, accounts: rows.map((r) => buildAccountRow(r, R, bot, now)) });
    } catch (e) {
      return json(res, 500, { error: "Failed to load userbase", detail: e instanceof Error ? e.message : undefined });
    }
  }

  // ---- batch balance sweep ----
  if (rest === "balances") {
    const ids = uuidList(u.searchParams.get("ids"));
    if (!ids.length) return json(res, 400, { error: "ids required (comma-separated account ids, max 12)" });
    try {
      const conns = await db.select({
        id: accountConnectionsTable.id, accountId: accountConnectionsTable.accountId, kind: accountConnectionsTable.kind,
        label: accountConnectionsTable.label, createdAt: accountConnectionsTable.createdAt,
        nwcUrlEncrypted: accountConnectionsTable.nwcUrlEncrypted, blinkApiKeyEncrypted: accountConnectionsTable.blinkApiKeyEncrypted,
        blinkWalletId: accountConnectionsTable.blinkWalletId,
      }).from(accountConnectionsTable).where(inArray(accountConnectionsTable.accountId, ids)).orderBy(accountConnectionsTable.createdAt, accountConnectionsTable.id);
      const defaults = await db.select({ accountId: accountsTable.id, defaultConnectionId: accountsTable.defaultConnectionId })
        .from(accountsTable).where(inArray(accountsTable.id, ids));
      const results = await Promise.all(ids.map(async (accountId) => {
        const mine = conns.filter((c) => c.accountId === accountId);
        const defId = defaults.find((d) => d.accountId === accountId)?.defaultConnectionId ?? null;
        const pick = mine.find((c) => c.id === defId && (c.kind === "nwc" || c.kind === "blink"))
          ?? mine.find((c) => c.kind === "nwc" || c.kind === "blink") ?? null;
        if (!pick) return { accountId, ok: false, error: mine.length ? "No balance-capable wallet connected" : "No wallet connected" };
        const bal = await readConnectionBalance(pick);
        return { accountId, kind: pick.kind, label: pick.label, isDefault: pick.id === defId, ...bal };
      }));
      return json(res, 200, { results });
    } catch (e) {
      return json(res, 500, { error: "Balance sweep failed", detail: e instanceof Error ? e.message : undefined });
    }
  }

  // ---- per-account routes ----
  const parts = rest.split("/");
  const accountId = parts[0];
  if (!UUID_RE.test(accountId)) return json(res, 404, { error: "Unknown account" });

  if (parts[1] === "balances") {
    try {
      const conns = await db.select({
        id: accountConnectionsTable.id, kind: accountConnectionsTable.kind, label: accountConnectionsTable.label,
        createdAt: accountConnectionsTable.createdAt, nwcUrlEncrypted: accountConnectionsTable.nwcUrlEncrypted,
        blinkApiKeyEncrypted: accountConnectionsTable.blinkApiKeyEncrypted, blinkWalletId: accountConnectionsTable.blinkWalletId,
      }).from(accountConnectionsTable).where(eq(accountConnectionsTable.accountId, accountId)).orderBy(accountConnectionsTable.createdAt, accountConnectionsTable.id);
      const results = await Promise.all(conns.map(async (c) => ({ connectionId: c.id, kind: c.kind, label: c.label, ...(await readConnectionBalance(c)) })));
      return json(res, 200, { results });
    } catch (e) {
      return json(res, 500, { error: "Balance read failed", detail: e instanceof Error ? e.message : undefined });
    }
  }
  if (parts.length > 1) return json(res, 404, { error: "Unknown route" });

  // ---- detail ----
  try {
    const [a] = await db.select({
      accountId: accountsTable.id, entityId: accountsTable.entityId, handle: entitiesTable.handle,
      email: entitiesTable.email, phone: entitiesTable.phone, phoneVerified: entitiesTable.phoneVerified,
      pinUpgraded: entitiesTable.pinUpgraded, totpEnabled: entitiesTable.totpEnabled, totpSecret: entitiesTable.totpSecret,
      recoveryEmail: entitiesTable.recoveryEmail, loginFailCount: entitiesTable.loginFailCount,
      loginLockedUntil: entitiesTable.loginLockedUntil, isSystem: entitiesTable.isSystem,
      businessName: accountsTable.businessName, type: accountsTable.type, currency: accountsTable.currency,
      createdAt: accountsTable.createdAt,
      defaultConnectionId: accountsTable.defaultConnectionId, ricConnectionId: accountsTable.ricConnectionId,
      cardsConnectionId: accountsTable.cardsConnectionId, ricReceiveConnectionId: accountsTable.ricReceiveConnectionId,
      ricSendConnectionId: accountsTable.ricSendConnectionId, cardsReceiveConnectionId: accountsTable.cardsReceiveConnectionId,
      cardsSendConnectionId: accountsTable.cardsSendConnectionId,
      lastIp: accountActivityTable.lastIp, lastTimezone: accountActivityTable.lastTimezone,
      lastUserAgent: accountActivityTable.lastUserAgent, lastSeenAt: accountActivityTable.lastSeenAt,
      firstSeenAt: accountActivityTable.firstSeenAt,
    }).from(accountsTable)
      .innerJoin(entitiesTable, eq(accountsTable.entityId, entitiesTable.id))
      .leftJoin(accountActivityTable, eq(accountActivityTable.accountId, accountsTable.id))
      .where(eq(accountsTable.id, accountId));
    if (!a) return json(res, 404, { error: "Unknown account" });

    const R = await loadRollups([accountId]);
    const bot = botStats();
    const base = buildAccountRow(a, R, bot, now);

    const connsFull = await db.select({
      id: accountConnectionsTable.id, kind: accountConnectionsTable.kind, mode: accountConnectionsTable.mode,
      label: accountConnectionsTable.label, createdAt: accountConnectionsTable.createdAt,
      lightningAddress: accountConnectionsTable.lightningAddress, clinkPointer: accountConnectionsTable.clinkPointer,
      clinkHookId: accountConnectionsTable.clinkHookId, nwcUrlEncrypted: accountConnectionsTable.nwcUrlEncrypted,
      blinkApiKeyEncrypted: accountConnectionsTable.blinkApiKeyEncrypted,
    }).from(accountConnectionsTable).where(eq(accountConnectionsTable.accountId, accountId)).orderBy(accountConnectionsTable.createdAt, accountConnectionsTable.id);

    const devicesFull = (R.devices as DeviceRow[]).map((d) => devicePublic(d, now));

    const cardsFull = await db.select({
      id: cardsTable.id, uid: cardsTable.uid, name: cardsTable.name, note: cardsTable.note, status: cardsTable.status,
      counter: cardsTable.counter, perTapLimitSats: cardsTable.perTapLimitSats, dailyLimitSats: cardsTable.dailyLimitSats,
      lastUsedAt: cardsTable.lastUsedAt, pinLockedAt: cardsTable.pinLockedAt, pinFailCount: cardsTable.pinFailCount,
      createdAt: cardsTable.createdAt,
    }).from(cardsTable).where(eq(cardsTable.accountId, accountId)).orderBy(cardsTable.createdAt, cardsTable.id);

    const txs = await db.select({
      id: transactionsTable.id, direction: transactionsTable.direction, type: transactionsTable.type,
      status: transactionsTable.status, amountSats: transactionsTable.amountSats, feeSats: transactionsTable.feeSats,
      memo: transactionsTable.memo, origin: transactionsTable.origin, counterpartHandle: transactionsTable.counterpartHandle,
      counterpartLnAddress: transactionsTable.counterpartLnAddress, class: transactionsTable.class,
      failureReason: transactionsTable.failureReason, createdAt: transactionsTable.createdAt,
    }).from(transactionsTable).where(eq(transactionsTable.accountId, accountId)).orderBy(desc(transactionsTable.createdAt)).limit(30);

    const wraps = await db.select({
      id: pendingInvoicesTable.id, wrapStatus: pendingInvoicesTable.wrapStatus, amountSats: pendingInvoicesTable.amountSats,
      feeSats: pendingInvoicesTable.feeSats, memo: pendingInvoicesTable.memo, origin: pendingInvoicesTable.origin,
      deviceMac: pendingInvoicesTable.deviceMac, createdAt: pendingInvoicesTable.createdAt,
      paidAt: pendingInvoicesTable.paidAt, expiresAt: pendingInvoicesTable.expiresAt,
    }).from(pendingInvoicesTable).where(eq(pendingInvoicesTable.accountId, accountId)).orderBy(desc(pendingInvoicesTable.createdAt)).limit(20);

    return json(res, 200, {
      account: base,
      security: {
        phoneVerified: a.phoneVerified, pinUpgraded: a.pinUpgraded, totpEnabled: a.totpEnabled,
        hasTotpSecret: !!a.totpSecret, hasRecoveryEmail: !!a.recoveryEmail,
        loginFailCount: a.loginFailCount, loginLockedUntil: a.loginLockedUntil,
      },
      connections: connsFull.map((c) => ({
        id: c.id, kind: c.kind, mode: c.mode, label: c.label, createdAt: c.createdAt,
        lightningAddress: c.lightningAddress, clinkPointer: c.clinkPointer, hasWebhook: !!c.clinkHookId,
        hasStoredKey: !!(c.nwcUrlEncrypted || c.blinkApiKeyEncrypted),
        roles: connRoles(a, c.id),
      })),
      devices: devicesFull,
      cards: cardsFull,
      transactions: txs,
      wraps,
    });
  } catch (e) {
    return json(res, 500, { error: "Failed to load account", detail: e instanceof Error ? e.message : undefined });
  }
}
