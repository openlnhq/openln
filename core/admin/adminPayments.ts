/**
 * Admin payments ops API — banker / treasury console backend.
 *
 * Ported verbatim (query/aggregate/business logic) from bitPOS's
 * artifacts/api-server/src/routes/adminPayments.ts, adapted from an Express
 * Router to openLN's inline http.createServer handler-function style.
 *
 * Auth: X-Admin-Secret header matching ADMIN_SECRET, OR a resolved session
 * account whose entity handle is in the ADMIN_HANDLES allowlist (default
 * 'kongzi'). See isAdmin() below — same security semantics as bitPOS's
 * requireAdmin (adminSecretOk() checked first, then session+handle).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  db,
  pendingInvoicesTable,
  transactionsTable,
  paymentEventsTable,
  accountsTable,
  entitiesTable,
} from "../db/index.js";
import { and, or, eq, desc, sql, ilike, isNotNull, inArray } from "drizzle-orm";
import { advanceWrap, type WrapRow } from "../money/holdWrap.js";
import {
  lookupInvoice,
  lookupOutgoingPayment,
  PLATFORM_NWC_URL,
  getBalance,
  getAccountNwcUrl,
} from "../money/nwc.js";
import { finalizePendingSend, checkOwnSettlementProof } from "../money/feeEngine.js";
import { extractPaymentHash } from "../money/lnAddress.js";
import { recordPaymentEventSync } from "../money/paymentLog.js";

type SessionAccount = { id: string; handle: string; createdAt: string } | undefined;

const json = (r: ServerResponse, s: number, b: unknown): true => {
  r.writeHead(s, { "content-type": "application/json" });
  r.end(JSON.stringify(b));
  return true;
};

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const c of req) raw += c;
  if (!raw) return {};
  if ((req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return JSON.parse(raw);
}

const ADMIN_HANDLES = new Set(
  (process.env.ADMIN_HANDLES ?? "kongzi")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const MAX_OPEN_WRAPS = 25;
const FLOAT_MARGIN_SATS = 10;

function adminSecretOk(req: IncomingMessage): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const provided = req.headers["x-admin-secret"];
  const val = Array.isArray(provided) ? provided[0] : provided;
  return !!val && val === secret;
}

/**
 * Ported verbatim (security semantics) from bitPOS's requireAdmin: check the
 * admin secret header first, then fall back to a resolved session account
 * whose handle is allowlisted. openLN's AuthService.authenticate() already
 * resolves the account with its entity handle attached, so no extra join is
 * needed here (bitPOS had to join accounts->entities for this; openLN's
 * session account object already carries `handle`).
 */
async function isAdmin(req: IncomingMessage, sessionAccount: SessionAccount): Promise<boolean> {
  if (adminSecretOk(req)) return true;
  if (!sessionAccount) return false;
  return ADMIN_HANDLES.has(sessionAccount.handle.toLowerCase());
}

const WRAP_STATUS_META: Record<
  string,
  { label: string; color: string; mile: "first_mile" | "last_mile" | "both" | "terminal"; step: number }
> = {
  created: { label: "Hold open", color: "slate", mile: "first_mile", step: 0 },
  accepted: { label: "Customer paid", color: "blue", mile: "first_mile", step: 1 },
  forwarding: { label: "Paying merchant", color: "amber", mile: "last_mile", step: 2 },
  forwarded: { label: "Merchant paid", color: "violet", mile: "last_mile", step: 3 },
  settled: { label: "Settled", color: "green", mile: "terminal", step: 4 },
  cancelled: { label: "Cancelled", color: "red", mile: "terminal", step: -1 },
  needs_reconciliation: { label: "Needs recon", color: "rose", mile: "both", step: -2 },
};

const PIPELINE_STEPS = ["created", "accepted", "forwarding", "forwarded", "settled"] as const;

function buildSyntheticTimeline(inv: {
  id: string;
  wrapStatus: string | null;
  createdAt: Date;
  wrapUpdatedAt: Date | null;
  paidAt: Date | null;
  expiresAt: Date;
  amountSats: number;
  feeSats: number | null;
  paymentHash: string;
  merchantPaymentHash: string | null;
  merchantBolt11: string | null;
}): Array<{
  at: string;
  event: string;
  status: string;
  mile: string | null;
  message: string;
  source: "synthetic" | "event";
}> {
  const events: Array<{
    at: string;
    event: string;
    status: string;
    mile: string | null;
    message: string;
    source: "synthetic" | "event";
  }> = [];

  events.push({
    at: inv.createdAt.toISOString(),
    event: "wrap.created",
    status: "info",
    mile: "first_mile",
    message: `Hold invoice created for ${inv.amountSats} sats (fee ${inv.feeSats ?? 0}). Hash ${inv.paymentHash.slice(0, 12)}…`,
    source: "synthetic",
  });

  const status = inv.wrapStatus ?? "created";
  const touch = inv.wrapUpdatedAt ?? inv.paidAt ?? inv.createdAt;

  if (["accepted", "forwarding", "forwarded", "settled"].includes(status)) {
    events.push({
      at: touch.toISOString(),
      event: "wrap.accepted",
      status: "success",
      mile: "first_mile",
      message: "1ST MILE — customer HTLC accepted on platform hold.",
      source: "synthetic",
    });
  }

  if (["forwarding", "forwarded", "settled"].includes(status)) {
    events.push({
      at: touch.toISOString(),
      event: "wrap.forwarding",
      status: status === "forwarding" ? "pending" : "info",
      mile: "last_mile",
      message: inv.merchantPaymentHash
        ? `2ND MILE — platform → merchant ${inv.merchantPaymentHash.slice(0, 12)}…`
        : "2ND MILE — platform → merchant.",
      source: "synthetic",
    });
  }

  if (["forwarded", "settled"].includes(status)) {
    events.push({
      at: touch.toISOString(),
      event: "wrap.forwarded",
      status: "success",
      mile: "last_mile",
      message: "2ND MILE success — merchant payment settled.",
      source: "synthetic",
    });
  }

  if (status === "settled") {
    events.push({
      at: (inv.paidAt ?? touch).toISOString(),
      event: "wrap.settled",
      status: "success",
      mile: "both",
      message: "Both miles complete. Hold settled. Fee captured.",
      source: "synthetic",
    });
  }

  if (status === "cancelled") {
    events.push({
      at: touch.toISOString(),
      event: "wrap.cancelled",
      status: "fail",
      mile: "both",
      message: "Wrap cancelled — customer hold released.",
      source: "synthetic",
    });
  }

  if (status === "needs_reconciliation") {
    events.push({
      at: touch.toISOString(),
      event: "wrap.needs_reconciliation",
      status: "ambiguous",
      mile: "both",
      message: "STUCK — needs manual reconciliation.",
      source: "synthetic",
    });
  }

  if (status === "created" && inv.expiresAt < new Date()) {
    events.push({
      at: inv.expiresAt.toISOString(),
      event: "wrap.expired",
      status: "fail",
      mile: "first_mile",
      message: "Hold expired before customer payment.",
      source: "synthetic",
    });
  }

  return events;
}

async function loadTreasury() {
  const [wrapAgg] = await db
    .select({
      settled: sql<number>`count(*) filter (where ${pendingInvoicesTable.wrapStatus} = 'settled')::int`,
      cancelled: sql<number>`count(*) filter (where ${pendingInvoicesTable.wrapStatus} = 'cancelled')::int`,
      open: sql<number>`count(*) filter (where ${pendingInvoicesTable.wrapStatus} in ('created','accepted','forwarding','forwarded'))::int`,
      stuck: sql<number>`count(*) filter (where ${pendingInvoicesTable.wrapStatus} = 'needs_reconciliation')::int`,
      wrappedTotal: sql<number>`count(*) filter (where ${pendingInvoicesTable.wrapStatus} is not null)::int`,
      feeRevenueSats: sql<number>`coalesce(sum(${pendingInvoicesTable.feeSats}) filter (where ${pendingInvoicesTable.wrapStatus} = 'settled'), 0)::int`,
      wrappedVolumeSats: sql<number>`coalesce(sum(${pendingInvoicesTable.amountSats}) filter (where ${pendingInvoicesTable.wrapStatus} = 'settled'), 0)::int`,
      merchantPaidSats: sql<number>`coalesce(sum(${pendingInvoicesTable.amountSats} - coalesce(${pendingInvoicesTable.feeSats},0)) filter (where ${pendingInvoicesTable.wrapStatus} = 'settled'), 0)::int`,
      openVolumeSats: sql<number>`coalesce(sum(${pendingInvoicesTable.amountSats}) filter (where ${pendingInvoicesTable.wrapStatus} in ('created','accepted','forwarding','forwarded')), 0)::int`,
      openObligationSats: sql<number>`coalesce(sum(${pendingInvoicesTable.amountSats} - coalesce(${pendingInvoicesTable.feeSats},0)) filter (where ${pendingInvoicesTable.wrapStatus} in ('created','accepted','forwarding')), 0)::int`,
      cancelledVolumeSats: sql<number>`coalesce(sum(${pendingInvoicesTable.amountSats}) filter (where ${pendingInvoicesTable.wrapStatus} = 'cancelled'), 0)::int`,
      cancelledFeesSats: sql<number>`coalesce(sum(${pendingInvoicesTable.feeSats}) filter (where ${pendingInvoicesTable.wrapStatus} = 'cancelled'), 0)::int`,
    })
    .from(pendingInvoicesTable);

  const [directAgg] = await db
    .select({
      directInvoices: sql<number>`count(*) filter (where ${pendingInvoicesTable.wrapStatus} is null)::int`,
      directVolumeSats: sql<number>`coalesce(sum(${pendingInvoicesTable.amountSats}) filter (where ${pendingInvoicesTable.wrapStatus} is null and ${pendingInvoicesTable.paidAt} is not null), 0)::int`,
      directUnpaid: sql<number>`count(*) filter (where ${pendingInvoicesTable.wrapStatus} is null and ${pendingInvoicesTable.paidAt} is null)::int`,
    })
    .from(pendingInvoicesTable);

  const [txAgg] = await db
    .select({
      completedIn: sql<number>`count(*) filter (where ${transactionsTable.status} = 'completed' and ${transactionsTable.direction} = 'in')::int`,
      completedOut: sql<number>`count(*) filter (where ${transactionsTable.status} = 'completed' and ${transactionsTable.direction} = 'out')::int`,
      failedOut: sql<number>`count(*) filter (where ${transactionsTable.status} = 'failed')::int`,
      pending: sql<number>`count(*) filter (where ${transactionsTable.status} = 'pending')::int`,
      volumeInSats: sql<number>`coalesce(sum(${transactionsTable.amountSats}) filter (where ${transactionsTable.status} = 'completed' and ${transactionsTable.direction} = 'in'), 0)::int`,
      volumeOutSats: sql<number>`coalesce(sum(${transactionsTable.amountSats}) filter (where ${transactionsTable.status} = 'completed' and ${transactionsTable.direction} = 'out'), 0)::int`,
      failedOutSats: sql<number>`coalesce(sum(${transactionsTable.amountSats}) filter (where ${transactionsTable.status} = 'failed'), 0)::int`,
    })
    .from(transactionsTable);

  // Pipeline counts by state (wrap only)
  const pipelineRows = await db
    .select({
      status: pendingInvoicesTable.wrapStatus,
      n: sql<number>`count(*)::int`,
      volume: sql<number>`coalesce(sum(${pendingInvoicesTable.amountSats}), 0)::int`,
    })
    .from(pendingInvoicesTable)
    .where(isNotNull(pendingInvoicesTable.wrapStatus))
    .groupBy(pendingInvoicesTable.wrapStatus);

  const pipeline: Record<string, { count: number; volumeSats: number }> = {};
  for (const s of PIPELINE_STEPS) pipeline[s] = { count: 0, volumeSats: 0 };
  pipeline.cancelled = { count: 0, volumeSats: 0 };
  pipeline.needs_reconciliation = { count: 0, volumeSats: 0 };
  for (const r of pipelineRows) {
    if (!r.status) continue;
    pipeline[r.status] = { count: r.n, volumeSats: r.volume };
  }

  // Float wallet balance (platform NWC)
  let floatBalanceSats: number | null = null;
  let floatError: string | null = null;
  if (PLATFORM_NWC_URL) {
    try {
      const bal = await getBalance(PLATFORM_NWC_URL);
      floatBalanceSats = bal.balanceSats;
    } catch (err) {
      floatError = err instanceof Error ? err.message : String(err);
    }
  } else {
    floatError = "PLATFORM_NWC_URL not configured";
  }

  const obligation = wrapAgg?.openObligationSats ?? 0;
  const available =
    floatBalanceSats == null ? null : Math.max(0, floatBalanceSats - obligation - FLOAT_MARGIN_SATS);

  // Last 24h activity
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [last24] = await db
    .select({
      wrapsSettled: sql<number>`count(*) filter (where ${pendingInvoicesTable.wrapStatus} = 'settled' and ${pendingInvoicesTable.paidAt} >= ${dayAgo})::int`,
      feeSats: sql<number>`coalesce(sum(${pendingInvoicesTable.feeSats}) filter (where ${pendingInvoicesTable.wrapStatus} = 'settled' and ${pendingInvoicesTable.paidAt} >= ${dayAgo}), 0)::int`,
      volumeSats: sql<number>`coalesce(sum(${pendingInvoicesTable.amountSats}) filter (where ${pendingInvoicesTable.wrapStatus} = 'settled' and ${pendingInvoicesTable.paidAt} >= ${dayAgo}), 0)::int`,
    })
    .from(pendingInvoicesTable);

  const [tx24] = await db
    .select({
      sends: sql<number>`count(*) filter (where ${transactionsTable.direction} = 'out' and ${transactionsTable.createdAt} >= ${dayAgo})::int`,
      sendFails: sql<number>`count(*) filter (where ${transactionsTable.direction} = 'out' and ${transactionsTable.status} = 'failed' and ${transactionsTable.createdAt} >= ${dayAgo})::int`,
      sendVolume: sql<number>`coalesce(sum(${transactionsTable.amountSats}) filter (where ${transactionsTable.direction} = 'out' and ${transactionsTable.status} = 'completed' and ${transactionsTable.createdAt} >= ${dayAgo}), 0)::int`,
    })
    .from(transactionsTable);

  return {
    float: {
      balanceSats: floatBalanceSats,
      obligationSats: obligation,
      availableSats: available,
      openWraps: wrapAgg?.open ?? 0,
      openCap: MAX_OPEN_WRAPS,
      marginSats: FLOAT_MARGIN_SATS,
      error: floatError,
      configured: !!PLATFORM_NWC_URL,
    },
    revenue: {
      feeRevenueSats: wrapAgg?.feeRevenueSats ?? 0,
      wrappedVolumeSats: wrapAgg?.wrappedVolumeSats ?? 0,
      merchantPaidSats: wrapAgg?.merchantPaidSats ?? 0,
      settledWraps: wrapAgg?.settled ?? 0,
      cancelledWraps: wrapAgg?.cancelled ?? 0,
      cancelledVolumeSats: wrapAgg?.cancelledVolumeSats ?? 0,
      effectiveFeeBps:
        (wrapAgg?.wrappedVolumeSats ?? 0) > 0
          ? Math.round(((wrapAgg?.feeRevenueSats ?? 0) / (wrapAgg?.wrappedVolumeSats ?? 1)) * 10000)
          : 0,
    },
    mix: {
      wrappedInvoices: wrapAgg?.wrappedTotal ?? 0,
      directInvoices: directAgg?.directInvoices ?? 0,
      directPaidVolumeSats: directAgg?.directVolumeSats ?? 0,
      note:
        "Most POS invoices historically are DIRECT (no wrap) when float was low, fee rounded to 0, or wrap unavailable. Only wrapped sales capture the 1% fee.",
    },
    pipeline,
    transactions: {
      completedIn: txAgg?.completedIn ?? 0,
      completedOut: txAgg?.completedOut ?? 0,
      failedOut: txAgg?.failedOut ?? 0,
      pending: txAgg?.pending ?? 0,
      volumeInSats: txAgg?.volumeInSats ?? 0,
      volumeOutSats: txAgg?.volumeOutSats ?? 0,
      failedOutSats: txAgg?.failedOutSats ?? 0,
    },
    last24h: {
      wrapsSettled: last24?.wrapsSettled ?? 0,
      feeSats: last24?.feeSats ?? 0,
      wrapVolumeSats: last24?.volumeSats ?? 0,
      sends: tx24?.sends ?? 0,
      sendFails: tx24?.sendFails ?? 0,
      sendVolumeSats: tx24?.sendVolume ?? 0,
    },
    wraps: {
      settled: wrapAgg?.settled ?? 0,
      cancelled: wrapAgg?.cancelled ?? 0,
      open: wrapAgg?.open ?? 0,
      stuck: wrapAgg?.stuck ?? 0,
      openVolumeSats: wrapAgg?.openVolumeSats ?? 0,
    },
  };
}

/**
 * Single hook point mounted from core/server.ts:
 *   if (await handleAdminPaymentsRoute(req, res, u, sessionAccount)) return;
 *
 * Handles every /api/admin/payments* route. Returns true once a route has
 * been matched and responded to (whether it succeeded, 4xx'd, or 5xx'd);
 * returns false when nothing under this prefix matched so server.ts's own
 * routing (and its 404 fallback) continues unaffected.
 */
export async function handleAdminPaymentsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  u: URL,
  sessionAccount: SessionAccount,
): Promise<boolean> {
  if (!u.pathname.startsWith("/api/admin/payments")) return false;

  const admin = await isAdmin(req, sessionAccount);
  if (!admin) {
    return json(res, sessionAccount ? 403 : 401, {
      error: sessionAccount ? "Admin access required" : "Unauthorized",
    });
  }

  // ── GET /api/admin/payments/treasury ────────────────────────────────────
  if (req.method === "GET" && u.pathname === "/api/admin/payments/treasury") {
    try {
      const treasury = await loadTreasury();
      return json(res, 200, treasury);
    } catch (err) {
      return json(res, 500, { error: "Failed to load treasury" });
    }
  }

  // ── GET /api/admin/payments ──────────────────────────────────────────────
  if (req.method === "GET" && u.pathname === "/api/admin/payments") {
    try {
      const q = (u.searchParams.get("q") ?? "").trim();
      const status = u.searchParams.get("status") ?? "";
      const kind = u.searchParams.get("kind") ?? "all";
      const limit = Math.min(Math.max(parseInt(u.searchParams.get("limit") ?? "80", 10) || 80, 1), 200);
      const offset = Math.max(parseInt(u.searchParams.get("offset") ?? "0", 10) || 0, 0);
      const includeTreasury = u.searchParams.get("treasury") !== "0";

      const wrapConditions = [];
      if (kind === "wrap" || kind === "stuck" || kind === "all") {
        wrapConditions.push(isNotNull(pendingInvoicesTable.wrapStatus));
      }
      if (kind === "stuck") {
        wrapConditions.push(
          inArray(pendingInvoicesTable.wrapStatus, [
            "forwarding",
            "forwarded",
            "accepted",
            "needs_reconciliation",
          ]),
        );
      }
      if (status && status !== "all") {
        wrapConditions.push(eq(pendingInvoicesTable.wrapStatus, status));
      }
      if (q) {
        const like = `%${q}%`;
        wrapConditions.push(
          or(
            ilike(pendingInvoicesTable.paymentHash, like),
            ilike(pendingInvoicesTable.merchantPaymentHash, like),
            ilike(pendingInvoicesTable.bolt11, like),
            ilike(pendingInvoicesTable.memo, like),
            sql`${pendingInvoicesTable.id}::text ILIKE ${like}`,
            sql`${pendingInvoicesTable.accountId}::text ILIKE ${like}`,
          )!,
        );
      }

      const wraps =
        kind === "send"
          ? []
          : await db
              .select({
                id: pendingInvoicesTable.id,
                accountId: pendingInvoicesTable.accountId,
                amountSats: pendingInvoicesTable.amountSats,
                feeSats: pendingInvoicesTable.feeSats,
                wrapStatus: pendingInvoicesTable.wrapStatus,
                paymentHash: pendingInvoicesTable.paymentHash,
                merchantPaymentHash: pendingInvoicesTable.merchantPaymentHash,
                memo: pendingInvoicesTable.memo,
                paidAt: pendingInvoicesTable.paidAt,
                wrapUpdatedAt: pendingInvoicesTable.wrapUpdatedAt,
                expiresAt: pendingInvoicesTable.expiresAt,
                createdAt: pendingInvoicesTable.createdAt,
                hasMerchantBolt11: sql<boolean>`${pendingInvoicesTable.merchantBolt11} is not null`,
                hasHoldPreimage: sql<boolean>`${pendingInvoicesTable.holdPreimage} is not null`,
                hasPreimage: sql<boolean>`${pendingInvoicesTable.preimage} is not null`,
                handle: entitiesTable.handle,
                businessName: accountsTable.businessName,
              })
              .from(pendingInvoicesTable)
              .leftJoin(accountsTable, eq(accountsTable.id, pendingInvoicesTable.accountId))
              .leftJoin(entitiesTable, eq(entitiesTable.id, accountsTable.entityId))
              .where(wrapConditions.length ? and(...wrapConditions) : sql`true`)
              .orderBy(desc(pendingInvoicesTable.createdAt))
              .limit(limit)
              .offset(offset);

      const txConditions = [];
      if (kind === "send") txConditions.push(eq(transactionsTable.direction, "out"));
      if (kind === "stuck") txConditions.push(eq(transactionsTable.status, "pending"));
      if (status && status !== "all" && (kind === "send" || kind === "all" || kind === "stuck")) {
        if (["pending", "completed", "failed"].includes(status)) {
          txConditions.push(eq(transactionsTable.status, status as "pending" | "completed" | "failed"));
        }
      }
      if (q) {
        const like = `%${q}%`;
        txConditions.push(
          or(
            ilike(transactionsTable.paymentHash, like),
            ilike(transactionsTable.bolt11, like),
            ilike(transactionsTable.memo, like),
            ilike(transactionsTable.counterpartHandle, like),
            ilike(transactionsTable.counterpartLnAddress, like),
            sql`${transactionsTable.id}::text ILIKE ${like}`,
            sql`${transactionsTable.accountId}::text ILIKE ${like}`,
          )!,
        );
      }

      const txs =
        kind === "wrap"
          ? []
          : await db
              .select({
                id: transactionsTable.id,
                accountId: transactionsTable.accountId,
                direction: transactionsTable.direction,
                amountSats: transactionsTable.amountSats,
                feeSats: transactionsTable.feeSats,
                type: transactionsTable.type,
                status: transactionsTable.status,
                paymentHash: transactionsTable.paymentHash,
                bolt11: transactionsTable.bolt11,
                memo: transactionsTable.memo,
                failureReason: transactionsTable.failureReason,
                counterpartHandle: transactionsTable.counterpartHandle,
                counterpartLnAddress: transactionsTable.counterpartLnAddress,
                cardId: transactionsTable.cardId,
                createdAt: transactionsTable.createdAt,
                handle: entitiesTable.handle,
              })
              .from(transactionsTable)
              .leftJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
              .leftJoin(entitiesTable, eq(entitiesTable.id, accountsTable.entityId))
              .where(txConditions.length ? and(...txConditions) : sql`true`)
              .orderBy(desc(transactionsTable.createdAt))
              .limit(limit)
              .offset(offset);

      // Pair related send/receive by payment hash for dual-leg display
      const hashPairs = new Map<string, { in?: (typeof txs)[0]; out?: (typeof txs)[0] }>();
      for (const t of txs) {
        if (!t.paymentHash) continue;
        const slot = hashPairs.get(t.paymentHash) ?? {};
        if (t.direction === "in") slot.in = t;
        else slot.out = t;
        hashPairs.set(t.paymentHash, slot);
      }

      const treasury = includeTreasury ? await loadTreasury() : null;

      return json(res, 200, {
        wraps: wraps.map((w) => {
          const meta = WRAP_STATUS_META[w.wrapStatus ?? "created"] ?? WRAP_STATUS_META.created;
          const step = meta.step;
          const termFail = w.wrapStatus === "cancelled" || w.wrapStatus === "needs_reconciliation";
          return {
            ...w,
            kind: "wrap" as const,
            statusMeta: meta,
            pipeline: PIPELINE_STEPS.map((s, i) => ({
              key: s,
              done: termFail ? false : step >= 0 && i <= step,
              current: termFail ? false : PIPELINE_STEPS[step] === s,
              failed: termFail && s === "created",
            })),
            firstMile: {
              label: "Customer → Hold",
              hash: w.paymentHash,
              amountSats: w.amountSats,
              done: ["accepted", "forwarding", "forwarded", "settled"].includes(w.wrapStatus ?? ""),
            },
            lastMile: {
              label: "Float → Merchant",
              hash: w.merchantPaymentHash,
              amountSats: w.amountSats - (w.feeSats ?? 0),
              feeSats: w.feeSats,
              done: ["forwarded", "settled"].includes(w.wrapStatus ?? ""),
            },
          };
        }),
        transactions: txs.map((t) => ({
          ...t,
          kind: "tx" as const,
          pair: t.paymentHash ? hashPairs.get(t.paymentHash) ?? null : null,
        })),
        treasury,
        stats: treasury ? { wraps: treasury.wraps, transactions: treasury.transactions } : undefined,
        meta: { q, status, kind, limit, offset },
      });
    } catch (err) {
      return json(res, 500, { error: "Failed to list payments" });
    }
  }

  // ── GET /api/admin/payments/:id ─────────────────────────────────────────
  const detailMatch = u.pathname.match(/^\/api\/admin\/payments\/([^/]+)$/);
  if (req.method === "GET" && detailMatch) {
    try {
      const id = decodeURIComponent(detailMatch[1]);

      const [inv] = await db
        .select()
        .from(pendingInvoicesTable)
        .where(
          or(
            eq(pendingInvoicesTable.id, id),
            eq(pendingInvoicesTable.paymentHash, id),
            eq(pendingInvoicesTable.merchantPaymentHash, id),
          ),
        )
        .limit(1);

      const [tx] = await db
        .select()
        .from(transactionsTable)
        .where(or(eq(transactionsTable.id, id), eq(transactionsTable.paymentHash, id)))
        .limit(1);

      let handle: string | null = null;
      let businessName: string | null = null;
      const accountId = inv?.accountId ?? tx?.accountId;
      if (accountId) {
        const [a] = await db
          .select({ handle: entitiesTable.handle, businessName: accountsTable.businessName })
          .from(accountsTable)
          .innerJoin(entitiesTable, eq(entitiesTable.id, accountsTable.entityId))
          .where(eq(accountsTable.id, accountId))
          .limit(1);
        handle = a?.handle ?? null;
        businessName = a?.businessName ?? null;
      }

      const paymentIds = new Set<string>();
      if (inv) paymentIds.add(inv.id);
      if (tx) paymentIds.add(tx.id);
      if (inv?.paymentHash) paymentIds.add(inv.paymentHash);
      if (tx?.paymentHash) paymentIds.add(tx.paymentHash);

      const eventRows =
        paymentIds.size === 0
          ? []
          : await db
              .select()
              .from(paymentEventsTable)
              .where(
                or(
                  ...[...paymentIds].map((pid) => eq(paymentEventsTable.paymentId, pid)),
                  ...(inv?.paymentHash ? [eq(paymentEventsTable.paymentHash, inv.paymentHash)] : []),
                  ...(tx?.paymentHash ? [eq(paymentEventsTable.paymentHash, tx.paymentHash)] : []),
                ),
              )
              .orderBy(paymentEventsTable.createdAt)
              .limit(500);

      // Counterpart legs (same payment hash)
      let counterparts: unknown[] = [];
      const ph = inv?.paymentHash ?? tx?.paymentHash;
      if (ph) {
        counterparts = await db
          .select({
            id: transactionsTable.id,
            direction: transactionsTable.direction,
            status: transactionsTable.status,
            amountSats: transactionsTable.amountSats,
            handle: entitiesTable.handle,
            createdAt: transactionsTable.createdAt,
          })
          .from(transactionsTable)
          .leftJoin(accountsTable, eq(accountsTable.id, transactionsTable.accountId))
          .leftJoin(entitiesTable, eq(entitiesTable.id, accountsTable.entityId))
          .where(eq(transactionsTable.paymentHash, ph))
          .orderBy(transactionsTable.createdAt);
      }

      const timeline: Array<Record<string, unknown>> = [];

      if (inv && inv.wrapStatus) {
        for (const s of buildSyntheticTimeline({
          id: inv.id,
          wrapStatus: inv.wrapStatus,
          createdAt: inv.createdAt,
          wrapUpdatedAt: inv.wrapUpdatedAt,
          paidAt: inv.paidAt,
          expiresAt: inv.expiresAt,
          amountSats: inv.amountSats,
          feeSats: inv.feeSats,
          paymentHash: inv.paymentHash,
          merchantPaymentHash: inv.merchantPaymentHash,
          merchantBolt11: inv.merchantBolt11,
        })) {
          timeline.push(s);
        }
      }

      if (tx) {
        timeline.push({
          at: tx.createdAt.toISOString(),
          event: `tx.${tx.status}`,
          status: tx.status === "completed" ? "success" : tx.status === "failed" ? "fail" : "pending",
          mile: null,
          message: `${tx.direction} ${tx.type} ${tx.amountSats} sats — ${tx.status}${tx.failureReason ? `: ${tx.failureReason}` : ""}`,
          source: "synthetic",
        });
      }

      for (const e of eventRows) {
        timeline.push({
          at: e.createdAt.toISOString(),
          event: e.event,
          status: e.status,
          mile: e.mile,
          message: e.message,
          method: e.method,
          durationMs: e.durationMs,
          errorClass: e.errorClass,
          errorMessage: e.errorMessage,
          detail: e.detail,
          source: "event",
          id: e.id,
        });
      }

      timeline.sort((a, b) => String(a.at).localeCompare(String(b.at)));

      let live: Record<string, unknown> | null = null;
      if (inv?.wrapStatus && PLATFORM_NWC_URL) {
        try {
          const hold = await lookupInvoice(inv.paymentHash, PLATFORM_NWC_URL);
          let merchant: unknown = null;
          if (inv.merchantPaymentHash) {
            try {
              merchant = await lookupInvoice(inv.merchantPaymentHash, PLATFORM_NWC_URL);
            } catch {
              merchant = { error: "lookup failed" };
            }
          }
          live = {
            hold: { state: hold.state, type: hold.type, paidAt: hold.paidAt ?? null, paid: hold.paid },
            merchantOutgoing: merchant,
          };
        } catch (err) {
          live = { error: err instanceof Error ? err.message : String(err) };
        }
      }

      const stripSecrets = (row: Record<string, unknown> | null | undefined) => {
        if (!row) return null;
        const { holdPreimage: _h, preimage: _p, nwcUrlEncrypted: _n, ...rest } = row;
        return { ...rest, hasHoldPreimage: !!_h, hasPreimage: !!_p };
      };

      const meta = inv?.wrapStatus ? WRAP_STATUS_META[inv.wrapStatus] ?? null : null;
      const step = meta?.step ?? -1;

      return json(res, 200, {
        invoice: stripSecrets(inv as unknown as Record<string, unknown>),
        transaction: tx ? { ...tx, bolt11: tx.bolt11 ? `${tx.bolt11.slice(0, 24)}…` : null } : null,
        handle,
        businessName,
        counterparts,
        statusMeta: meta,
        pipeline: inv?.wrapStatus
          ? PIPELINE_STEPS.map((s, i) => ({
              key: s,
              label: WRAP_STATUS_META[s].label,
              done: step >= 0 && i <= step,
              current: step >= 0 && PIPELINE_STEPS[step] === s,
              failed: step < 0,
            }))
          : null,
        firstMile: inv
          ? {
              label: "Customer → Platform hold",
              paymentHash: inv.paymentHash,
              amountSats: inv.amountSats,
              done: ["accepted", "forwarding", "forwarded", "settled"].includes(inv.wrapStatus ?? ""),
              state: inv.wrapStatus,
            }
          : null,
        lastMile: inv
          ? {
              label: "Platform float → Merchant",
              paymentHash: inv.merchantPaymentHash,
              amountSats: inv.amountSats - (inv.feeSats ?? 0),
              feeSats: inv.feeSats,
              done: ["forwarded", "settled"].includes(inv.wrapStatus ?? ""),
              state: inv.wrapStatus,
            }
          : null,
        timeline,
        live,
        actions: {
          canAdvance: !!(inv?.wrapStatus && !["settled", "cancelled"].includes(inv.wrapStatus)),
          canLookup: !!(inv || tx),
          canRemediateTx: !!(tx && tx.direction === "out" && tx.status !== "completed"),
          canCancelHold: !!(
            inv?.wrapStatus &&
            ["created", "accepted", "needs_reconciliation", "forwarding"].includes(inv.wrapStatus)
          ),
        },
      });
    } catch (err) {
      return json(res, 500, { error: "Failed to load payment" });
    }
  }

  // ── POST /api/admin/payments/:id/advance ────────────────────────────────
  const advanceMatch = u.pathname.match(/^\/api\/admin\/payments\/([^/]+)\/advance$/);
  if (req.method === "POST" && advanceMatch) {
    try {
      const id = decodeURIComponent(advanceMatch[1]);
      const [inv] = await db.select().from(pendingInvoicesTable).where(eq(pendingInvoicesTable.id, id)).limit(1);
      if (!inv) return json(res, 404, { error: "Invoice not found" });
      if (!inv.wrapStatus) return json(res, 400, { error: "Not a wrapped invoice" });

      const before = inv.wrapStatus;
      const row: WrapRow = {
        id: inv.id,
        accountId: inv.accountId,
        paymentHash: inv.paymentHash,
        amountSats: inv.amountSats,
        merchantBolt11: inv.merchantBolt11,
        merchantPaymentHash: inv.merchantPaymentHash,
        feeSats: inv.feeSats,
        memo: inv.memo,
        bolt11: inv.bolt11,
        wrapStatus: inv.wrapStatus,
        preimage: inv.preimage,
        holdPreimage: inv.holdPreimage,
        wrapUpdatedAt: inv.wrapUpdatedAt,
        nwcUrlEncrypted: inv.nwcUrlEncrypted,
        paidAt: inv.paidAt,
        expiresAt: inv.expiresAt,
        fiatCurrency: inv.fiatCurrency,
        fiatAmount: inv.fiatAmount,
        fiatBaseRate: inv.fiatBaseRate,
        fiatEffectiveRate: inv.fiatEffectiveRate,
        fiatModifier: inv.fiatModifier,
        fiatRateSource: inv.fiatRateSource,
        fiatRateDirection: inv.fiatRateDirection,
        fiatRateAt: inv.fiatRateAt,
      };

      const after = await advanceWrap(row);

      await recordPaymentEventSync({
        paymentId: inv.id,
        accountId: inv.accountId,
        kind: "admin",
        event: "admin.advance_wrap",
        status: after === "settled" ? "success" : after === "needs_reconciliation" ? "ambiguous" : "info",
        mile: "both",
        message: `Admin advanced wrap: ${before} → ${after}`,
        paymentHash: inv.paymentHash,
        merchantPaymentHash: inv.merchantPaymentHash,
        amountSats: inv.amountSats,
        feeSats: inv.feeSats,
        detail: { before, after },
      });

      return json(res, 200, { ok: true, before, after });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : "Advance failed" });
    }
  }

  // ── POST /api/admin/payments/:id/lookup ─────────────────────────────────
  const lookupMatch = u.pathname.match(/^\/api\/admin\/payments\/([^/]+)\/lookup$/);
  if (req.method === "POST" && lookupMatch) {
    try {
      const id = decodeURIComponent(lookupMatch[1]);
      const [inv] = await db
        .select()
        .from(pendingInvoicesTable)
        .where(or(eq(pendingInvoicesTable.id, id), eq(pendingInvoicesTable.paymentHash, id)))
        .limit(1);
      const [tx] = await db
        .select()
        .from(transactionsTable)
        .where(or(eq(transactionsTable.id, id), eq(transactionsTable.paymentHash, id)))
        .limit(1);

      const result: Record<string, unknown> = {};

      if (inv && PLATFORM_NWC_URL) {
        try {
          result.hold = await lookupInvoice(inv.paymentHash, PLATFORM_NWC_URL);
        } catch (e) {
          result.hold = { error: e instanceof Error ? e.message : String(e) };
        }
        if (inv.merchantPaymentHash) {
          try {
            result.merchantOutgoing = await lookupInvoice(inv.merchantPaymentHash, PLATFORM_NWC_URL);
          } catch (e) {
            result.merchantOutgoing = { error: e instanceof Error ? e.message : String(e) };
          }
        }
      }

      if (PLATFORM_NWC_URL) {
        try {
          result.floatBalance = await getBalance(PLATFORM_NWC_URL);
        } catch (e) {
          result.floatBalance = { error: e instanceof Error ? e.message : String(e) };
        }
      }

      if (tx?.bolt11) {
        try {
          const nwc = await getAccountNwcUrl(tx.accountId);
          if (nwc) result.txOutgoing = await lookupOutgoingPayment(tx.bolt11, nwc);
        } catch (e) {
          result.txOutgoing = { error: e instanceof Error ? e.message : String(e) };
        }
        try {
          const hash = tx.paymentHash ?? (tx.bolt11 ? extractPaymentHash(tx.bolt11) : null);
          result.ownSettlementProof = await checkOwnSettlementProof(hash);
        } catch (e) {
          result.ownSettlementProof = { error: e instanceof Error ? e.message : String(e) };
        }
      }

      await recordPaymentEventSync({
        paymentId: inv?.id ?? tx?.id ?? id,
        accountId: inv?.accountId ?? tx?.accountId,
        kind: "admin",
        event: "admin.lookup",
        status: "info",
        message: "Admin live NWC lookup",
        paymentHash: inv?.paymentHash ?? tx?.paymentHash,
        detail: result,
      });

      return json(res, 200, { ok: true, result });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : "Lookup failed" });
    }
  }

  // ── POST /api/admin/payments/:id/remediate-tx ───────────────────────────
  const remediateMatch = u.pathname.match(/^\/api\/admin\/payments\/([^/]+)\/remediate-tx$/);
  if (req.method === "POST" && remediateMatch) {
    try {
      const id = decodeURIComponent(remediateMatch[1]);
      const b = (await body(req)) as { force?: boolean; dryRun?: boolean };
      const [tx] = await db.select().from(transactionsTable).where(eq(transactionsTable.id, id)).limit(1);
      if (!tx) return json(res, 404, { error: "Transaction not found" });
      if (tx.direction !== "out") return json(res, 400, { error: "Not an outgoing transaction" });
      if (tx.status === "completed") return json(res, 200, { ok: true, alreadyCompleted: true });

      let paymentHash = tx.paymentHash;
      if (!paymentHash && tx.bolt11) {
        try {
          paymentHash = extractPaymentHash(tx.bolt11);
        } catch {
          /* ignore */
        }
      }

      let proven = !!(await checkOwnSettlementProof(paymentHash).catch(() => null));
      let proofSource: string | null = proven ? "own_invoice_record" : null;

      if (!proven && tx.bolt11) {
        try {
          const nwcUrl = await getAccountNwcUrl(tx.accountId);
          if (nwcUrl) {
            const invLookup = await lookupOutgoingPayment(tx.bolt11, nwcUrl);
            if (invLookup.paid) {
              proven = true;
              proofSource = "wallet_lookup";
            }
          }
        } catch {
          /* remediate lookup failed - fall through to force check */
        }
      }

      if (!proven && !b.force) {
        return json(res, 409, {
          ok: false,
          error: "No settlement proof — pass force:true only with out-of-band proof",
          paymentHash,
          status: tx.status,
          failureReason: tx.failureReason,
        });
      }

      if (b.dryRun) {
        return json(res, 200, { ok: true, dryRun: true, proven, proofSource, wouldSet: "completed" });
      }

      await finalizePendingSend(tx.id, {
        status: "completed",
        paymentHash: paymentHash ?? undefined,
      });

      if (tx.status === "failed") {
        await db
          .update(transactionsTable)
          .set({ status: "completed", failureReason: null, ...(paymentHash ? { paymentHash } : {}) })
          .where(and(eq(transactionsTable.id, tx.id), eq(transactionsTable.status, "failed")));
      }

      await recordPaymentEventSync({
        paymentId: tx.id,
        accountId: tx.accountId,
        kind: "admin",
        event: "admin.remediate_tx",
        status: "success",
        message: `Admin remediated tx to completed (proof=${proofSource ?? "force"})`,
        paymentHash,
        amountSats: tx.amountSats,
        detail: { proven, proofSource, forced: !proven },
      });

      return json(res, 200, { ok: true, proven, proofSource });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : "Remediate failed" });
    }
  }

  // ── POST /api/admin/payments/events ─────────────────────────────────────
  if (req.method === "POST" && u.pathname === "/api/admin/payments/events") {
    try {
      const b = (await body(req)) as { paymentId?: string; message?: string; status?: string };
      if (!b.paymentId || !b.message) return json(res, 400, { error: "paymentId and message required" });
      await recordPaymentEventSync({
        paymentId: b.paymentId,
        kind: "admin",
        event: "admin.note",
        status: (b.status as "info") || "info",
        message: b.message,
      });
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 500, { error: "Failed to add note" });
    }
  }

  return json(res, 404, { error: "Not found" });
}
