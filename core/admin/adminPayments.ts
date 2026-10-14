/**
 * Admin payments ops API — banker / treasury console backend.
 *
 * Ported verbatim (query/aggregate/business logic) from bitPOS's
 * artifacts/api-server/src/routes/adminPayments.ts, adapted from an Express
 * Router to openLN's inline http.createServer handler-function style.
 *
 * Auth: X-Admin-Secret header matching ADMIN_SECRET, OR a resolved session
 * account whose entity handle is in the ADMIN_HANDLES allowlist. The gate is
 * shared with the userbase console: see ./adminAuth.js (adminSecretOk() checked
 * first, then session+handle - same security semantics as bitPOS's requireAdmin).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { humanizeFailure } from "../money/failureText.js";
import {
  db,
  pendingInvoicesTable,
  transactionsTable,
  paymentEventsTable,
  accountsTable,
  entitiesTable,
} from "../db/index.js";
import { and, or, eq, desc, asc, gte, sql, ilike, isNotNull, inArray } from "drizzle-orm";
import { advanceWrap, cancelWrap, type WrapRow } from "../money/holdWrap.js";
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
import { isAdmin } from "./adminAuth.js";

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

const MAX_OPEN_WRAPS = 25;
const FLOAT_MARGIN_SATS = 10;

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

// Wrap step timing: each transition is recorded in payment_events by the wrap
// engine (wrap.transition.<to>; wrap.settled at the end). Collect the earliest
// occurrence per step and derive per-leg durations for the ops UI.
const WRAP_STEP_EVENTS = [
  "wrap.transition.accepted",
  "wrap.transition.forwarding",
  "wrap.transition.forwarded",
  "wrap.settled",
] as const;
const STEP_EVENT_TO_KEY: Record<string, "accepted" | "forwarding" | "forwarded" | "settled"> = {
  "wrap.transition.accepted": "accepted",
  "wrap.transition.forwarding": "forwarding",
  "wrap.transition.forwarded": "forwarded",
  "wrap.settled": "settled",
};

type WrapStepTimes = Partial<Record<"accepted" | "forwarding" | "forwarded" | "settled", Date>>;

export type WrapSteps = {
  created: string | null;
  accepted: string | null;
  forwarding: string | null;
  forwarded: string | null;
  settled: string | null;
  // Derived leg durations (ms). payMs: customer pay; forwardMs: platform pays
  // merchant after acceptance; settleMs: hold settle after the forward;
  // totalMs: created -> last observed step.
  payMs: number | null;
  forwardMs: number | null;
  settleMs: number | null;
  totalMs: number | null;
};

function stepsFromTimestamps(
  inv: { createdAt: Date; paidAt: Date | null },
  times: WrapStepTimes,
): WrapSteps {
  const settled = times.settled ?? inv.paidAt ?? null;
  const ms = (a: Date | null, b: Date | null) => (a && b ? Math.max(0, a.getTime() - b.getTime()) : null);
  const last = settled ?? times.forwarded ?? times.forwarding ?? times.accepted ?? null;
  return {
    created: inv.createdAt.toISOString(),
    accepted: times.accepted?.toISOString() ?? null,
    forwarding: times.forwarding?.toISOString() ?? null,
    forwarded: times.forwarded?.toISOString() ?? null,
    settled: settled?.toISOString() ?? null,
    payMs: ms(times.accepted ?? null, inv.createdAt),
    forwardMs: ms(times.forwarded ?? null, times.accepted ?? null),
    settleMs: ms(settled, times.forwarded ?? null),
    totalMs: ms(last, inv.createdAt),
  };
}

// Fold the earliest event per step per wrap. Events are keyed sometimes by the
// wrap row id, sometimes by the hold payment hash (see the wrap engine's
// recordPaymentEvent calls), so match on both.
function collectStepTimes(
  rows: Array<{ paymentId: string; paymentHash: string | null; event: string; createdAt: Date }>,
  wraps: Array<{ id: string; paymentHash: string }>,
): Map<string, WrapStepTimes> {
  const byId = new Map<string, WrapStepTimes>();
  const byHash = new Map<string, WrapStepTimes>();
  const idSet = new Set(wraps.map((w) => w.id));
  const hashToId = new Map(wraps.map((w) => [w.paymentHash, w.id]));
  for (const e of rows) {
    const key = STEP_EVENT_TO_KEY[e.event];
    if (!key) continue;
    if (idSet.has(e.paymentId)) {
      const cur = byId.get(e.paymentId) ?? {};
      if (!cur[key]) cur[key] = e.createdAt;
      byId.set(e.paymentId, cur);
    }
    const idForHash = e.paymentHash ? hashToId.get(e.paymentHash) : undefined;
    if (idForHash) {
      const cur = byHash.get(idForHash) ?? {};
      if (!cur[key]) cur[key] = e.createdAt;
      byHash.set(idForHash, cur);
    }
  }
  const merged = new Map<string, WrapStepTimes>();
  for (const w of wraps) {
    const a = byId.get(w.id) ?? {};
    const b = byHash.get(w.id) ?? {};
    const out: WrapStepTimes = {};
    for (const k of ["accepted", "forwarding", "forwarded", "settled"] as const) {
      const av = a[k];
      const bv = b[k];
      out[k] = av && bv ? (av < bv ? av : bv) : av ?? bv ?? undefined;
    }
    merged.set(w.id, out);
  }
  return merged;
}

// Build the wrap-engine row shape from a pending_invoices record (shared by
// the admin advance and cancel actions).
function invToWrapRow(inv: typeof pendingInvoicesTable.$inferSelect): WrapRow {
  return {
    id: inv.id,
    accountId: inv.accountId,
    paymentHash: inv.paymentHash,
    amountSats: inv.amountSats,
    merchantBolt11: inv.merchantBolt11,
    merchantPaymentHash: inv.merchantPaymentHash,
    feeSats: inv.feeSats,
    memo: inv.memo,
    deviceMac: inv.deviceMac,
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
}

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
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [last24] = await db
    .select({
      wrapsSettled: sql<number>`count(*) filter (where ${pendingInvoicesTable.wrapStatus} = 'settled' and ${pendingInvoicesTable.paidAt} >= ${dayAgo})::int`,
      feeSats: sql<number>`coalesce(sum(${pendingInvoicesTable.feeSats}) filter (where ${pendingInvoicesTable.wrapStatus} = 'settled' and ${pendingInvoicesTable.paidAt} >= ${dayAgo}), 0)::int`,
      volumeSats: sql<number>`coalesce(sum(${pendingInvoicesTable.amountSats}) filter (where ${pendingInvoicesTable.wrapStatus} = 'settled' and ${pendingInvoicesTable.paidAt} >= ${dayAgo}), 0)::int`,
      avgSettleMs: sql<number | null>`(avg(extract(epoch from (${pendingInvoicesTable.paidAt} - ${pendingInvoicesTable.createdAt})) * 1000) filter (where ${pendingInvoicesTable.wrapStatus} = 'settled' and ${pendingInvoicesTable.paidAt} >= ${dayAgo}))::int`,
    })
    .from(pendingInvoicesTable);

  // Earnings windows + a 14-day daily series (settled wraps only; gross fee).
  const [winAgg] = await db
    .select({
      d1Wraps: sql<number>`count(*) filter (where ${pendingInvoicesTable.paidAt} >= ${dayAgo})::int`,
      d1Fees: sql<number>`coalesce(sum(${pendingInvoicesTable.feeSats}) filter (where ${pendingInvoicesTable.paidAt} >= ${dayAgo}), 0)::int`,
      d1Volume: sql<number>`coalesce(sum(${pendingInvoicesTable.amountSats}) filter (where ${pendingInvoicesTable.paidAt} >= ${dayAgo}), 0)::int`,
      d7Wraps: sql<number>`count(*) filter (where ${pendingInvoicesTable.paidAt} >= ${weekAgo})::int`,
      d7Fees: sql<number>`coalesce(sum(${pendingInvoicesTable.feeSats}) filter (where ${pendingInvoicesTable.paidAt} >= ${weekAgo}), 0)::int`,
      d7Volume: sql<number>`coalesce(sum(${pendingInvoicesTable.amountSats}) filter (where ${pendingInvoicesTable.paidAt} >= ${weekAgo}), 0)::int`,
      d30Wraps: sql<number>`count(*) filter (where ${pendingInvoicesTable.paidAt} >= ${monthAgo})::int`,
      d30Fees: sql<number>`coalesce(sum(${pendingInvoicesTable.feeSats}) filter (where ${pendingInvoicesTable.paidAt} >= ${monthAgo}), 0)::int`,
      d30Volume: sql<number>`coalesce(sum(${pendingInvoicesTable.amountSats}) filter (where ${pendingInvoicesTable.paidAt} >= ${monthAgo}), 0)::int`,
      d30AvgSettleMs: sql<number | null>`(avg(extract(epoch from (${pendingInvoicesTable.paidAt} - ${pendingInvoicesTable.createdAt})) * 1000) filter (where ${pendingInvoicesTable.paidAt} >= ${monthAgo}))::int`,
    })
    .from(pendingInvoicesTable)
    .where(eq(pendingInvoicesTable.wrapStatus, "settled"));

  const dailyRows = await db
    .select({
      date: sql<string>`to_char(date_trunc('day', ${pendingInvoicesTable.paidAt}), 'YYYY-MM-DD')`,
      wraps: sql<number>`count(*)::int`,
      feeSats: sql<number>`coalesce(sum(${pendingInvoicesTable.feeSats}), 0)::int`,
      volumeSats: sql<number>`coalesce(sum(${pendingInvoicesTable.amountSats}), 0)::int`,
    })
    .from(pendingInvoicesTable)
    .where(
      and(
        eq(pendingInvoicesTable.wrapStatus, "settled"),
        isNotNull(pendingInvoicesTable.paidAt),
        gte(pendingInvoicesTable.paidAt, monthAgo),
      ),
    )
    .groupBy(sql`date_trunc('day', ${pendingInvoicesTable.paidAt})`)
    .orderBy(sql`date_trunc('day', ${pendingInvoicesTable.paidAt})`);
  const dailyMap = new Map(dailyRows.map((r) => [r.date, r]));
  const daily: Array<{ date: string; wraps: number; feeSats: number; volumeSats: number }> = [];
  for (let i = 13; i >= 0; i--) {
    const key = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const row = dailyMap.get(key);
    daily.push({
      date: key,
      wraps: row?.wraps ?? 0,
      feeSats: row?.feeSats ?? 0,
      volumeSats: row?.volumeSats ?? 0,
    });
  }

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
      windows: {
        d1: { wraps: winAgg?.d1Wraps ?? 0, feeSats: winAgg?.d1Fees ?? 0, volumeSats: winAgg?.d1Volume ?? 0 },
        d7: { wraps: winAgg?.d7Wraps ?? 0, feeSats: winAgg?.d7Fees ?? 0, volumeSats: winAgg?.d7Volume ?? 0 },
        d30: { wraps: winAgg?.d30Wraps ?? 0, feeSats: winAgg?.d30Fees ?? 0, volumeSats: winAgg?.d30Volume ?? 0 },
      },
      daily,
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
      avgSettleMs: last24?.avgSettleMs ?? null,
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
            // Merchant identity: searching a handle or business name lists that
            // account's payments (the query already joins both for display).
            ilike(entitiesTable.handle, like),
            ilike(accountsTable.businessName, like),
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
            // Merchant identity: searching a handle or business name lists that
            // account's transactions (the query already joins both for display).
            ilike(entitiesTable.handle, like),
            ilike(accountsTable.businessName, like),
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

      // Wrap step timings from payment_events: earliest occurrence per step,
      // matched on wrap id or hold payment hash (the engine records both shapes).
      const wrapHashes = wraps.map((w) => w.paymentHash).filter((h): h is string => !!h);
      const stepRows =
        wraps.length === 0
          ? []
          : await db
              .select({
                paymentId: paymentEventsTable.paymentId,
                paymentHash: paymentEventsTable.paymentHash,
                event: paymentEventsTable.event,
                createdAt: paymentEventsTable.createdAt,
              })
              .from(paymentEventsTable)
              .where(
                and(
                  inArray(paymentEventsTable.event, [...WRAP_STEP_EVENTS]),
                  or(
                    inArray(paymentEventsTable.paymentId, wraps.map((w) => w.id)),
                    wrapHashes.length ? inArray(paymentEventsTable.paymentHash, wrapHashes) : sql`false`,
                  ),
                ),
              )
              .orderBy(asc(paymentEventsTable.createdAt));
      const stepTimes = collectStepTimes(
        stepRows,
        wraps.map((w) => ({ id: w.id, paymentHash: w.paymentHash })),
      );

      const treasury = includeTreasury ? await loadTreasury() : null;

      const wrapEntries = wraps.map((w) => {
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
            current: termFail ? false : step >= 0 && step < 4 && PIPELINE_STEPS[step] === s,
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
          steps: stepsFromTimestamps(w, stepTimes.get(w.id) ?? {}),
        };
      });

      // One entry per sale: each wrap carries its own transaction legs (the
      // payer row and the merchant receive row share the hold payment hash).
      // Transactions with no wrap on this page stay standalone rows.
      const wrapIdByHash = new Map<string, string>();
      for (const w of wraps) {
        if (w.paymentHash) wrapIdByHash.set(w.paymentHash, w.id);
        if (w.merchantPaymentHash) wrapIdByHash.set(w.merchantPaymentHash, w.id);
      }
      const legsByWrap = new Map<string, typeof txs>();
      const standalone: typeof txs = [];
      for (const t of txs) {
        const wid = t.paymentHash ? wrapIdByHash.get(t.paymentHash) : undefined;
        if (wid) {
          const arr = legsByWrap.get(wid) ?? [];
          arr.push(t);
          legsByWrap.set(wid, arr);
        } else {
          standalone.push(t);
        }
      }
      const payments = [
        ...wrapEntries.map((w) => ({
          id: w.id,
          kind: "wrap" as const,
          createdAt: (w.createdAt as Date).toISOString(),
          wrap: w,
          legs: (legsByWrap.get(w.id) ?? []).map((t) => ({
            ...t,
            pair: t.paymentHash ? hashPairs.get(t.paymentHash) ?? null : null,
          })),
        })),
        ...standalone.map((t) => ({
          id: t.id,
          kind: "tx" as const,
          createdAt: (t.createdAt as Date).toISOString(),
          tx: { ...t, kind: "tx" as const, pair: t.paymentHash ? hashPairs.get(t.paymentHash) ?? null : null },
        })),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      return json(res, 200, {
        payments,
        wraps: wrapEntries,
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
          // The merchant invoice is issued by the MERCHANT's wallet, so the
          // platform node can only see it once we PAID it (as an outgoing
          // payment). Before the forward it is "not found" by design; that is
          // not a failure. Say what the state means instead of "lookup failed".
          let merchant: unknown = null;
          if (inv.merchantPaymentHash) {
            const forwarded = ["forwarding", "forwarded", "settled"].includes(inv.wrapStatus);
            if (!forwarded) {
              merchant = { state: "not_started", note: "Forward has not been sent; the merchant invoice exists only on the merchant's wallet until then." };
            } else {
              try {
                const out = await lookupInvoice(inv.merchantPaymentHash, PLATFORM_NWC_URL);
                merchant = { state: out.state, type: out.type, paidAt: out.paidAt ?? null, paid: out.paid };
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                merchant = /not found/i.test(msg)
                  ? { state: "unknown", note: "Platform node has no record of this outgoing payment yet." }
                  : { state: "unavailable", note: `Relay error while looking up: ${msg}` };
              }
            }
          }
          live = {
            hold: { state: hold.state, type: hold.type, paidAt: hold.paidAt ?? null, paid: hold.paid },
            merchantOutgoing: merchant,
            holdExpired: inv.expiresAt ? inv.expiresAt.getTime() < Date.now() : null,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          live = { error: /not found/i.test(msg) ? "Hold not found on the platform node (expired or never created there)" : `Relay error: ${msg}` };
        }
      }

      const stripSecrets = (row: Record<string, unknown> | null | undefined) => {
        if (!row) return null;
        const { holdPreimage: _h, preimage: _p, nwcUrlEncrypted: _n, ...rest } = row;
        return { ...rest, hasHoldPreimage: !!_h, hasPreimage: !!_p };
      };

      const meta = inv?.wrapStatus ? WRAP_STATUS_META[inv.wrapStatus] ?? null : null;
      const step = meta?.step ?? -1;

      // Step timings for the detail view: earliest event per transition.
      const stepTimesDetail: WrapStepTimes = {};
      for (const e of eventRows) {
        const key = STEP_EVENT_TO_KEY[e.event];
        if (!key) continue;
        const cur = stepTimesDetail[key];
        if (!cur || e.createdAt < cur) stepTimesDetail[key] = e.createdAt;
      }
      const steps = inv ? stepsFromTimestamps(inv, stepTimesDetail) : null;

      return json(res, 200, {
        invoice: stripSecrets(inv as unknown as Record<string, unknown>),
        transaction: tx ? { ...tx, bolt11: tx.bolt11 ? `${tx.bolt11.slice(0, 24)}…` : null } : null,
        handle,
        businessName,
        counterparts,
        statusMeta: meta,
        steps,
        pipeline: inv?.wrapStatus
          ? PIPELINE_STEPS.map((s, i) => ({
              key: s,
              label: WRAP_STATUS_META[s].label,
              done: step >= 0 && i <= step,
              current: step >= 0 && step < 4 && PIPELINE_STEPS[step] === s,
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
          // A "created" wrap holds nothing - closing it is a clean no-money
          // action (cancelWrap re-checks the wallet first). Past that point the
          // engine owns the refund path, so the admin lever is advance/lookup.
          canCancelHold: inv?.wrapStatus === "created",
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
      const row: WrapRow = invToWrapRow(inv);

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

  // ── POST /api/admin/payments/:id/cancel-hold ────────────────────────────
  // Close a stuck "created" checkout: only safe while the customer's payment
  // has never been accepted. cancelWrap re-checks the wallet first and will
  // advance instead if the money DID arrive - funds are never put at risk.
  const cancelHoldMatch = u.pathname.match(/^\/api\/admin\/payments\/([^/]+)\/cancel-hold$/);
  if (req.method === "POST" && cancelHoldMatch) {
    try {
      const id = decodeURIComponent(cancelHoldMatch[1]);
      const [inv] = await db
        .select()
        .from(pendingInvoicesTable)
        .where(or(eq(pendingInvoicesTable.id, id), eq(pendingInvoicesTable.paymentHash, id)))
        .limit(1);
      if (!inv) return json(res, 404, { error: "Invoice not found" });
      if (!inv.wrapStatus) return json(res, 400, { error: "Not a wrapped invoice" });
      if (inv.wrapStatus !== "created") {
        return json(res, 409, {
          ok: false,
          status: inv.wrapStatus,
          error: "The hold is past 'created' - it can only be advanced or settled, not cancelled",
        });
      }

      const before = inv.wrapStatus;
      const after = await cancelWrap(invToWrapRow(inv), "admin closed the checkout");
      if (after !== "cancelled") {
        await recordPaymentEventSync({
          paymentId: inv.id,
          accountId: inv.accountId,
          kind: "admin",
          event: "admin.cancel_hold",
          status: "ambiguous",
          mile: "first_mile",
          message: `Admin cancel refused - the wallet shows activity or the wrap moved on (now ${after})`,
          paymentHash: inv.paymentHash,
          merchantPaymentHash: inv.merchantPaymentHash,
          amountSats: inv.amountSats,
          feeSats: inv.feeSats,
          detail: { before, after, cancelled: false },
        });
        return json(res, 200, {
          ok: false,
          before,
          after,
          note: "Nothing was cancelled - the wallet shows activity or the wrap moved on.",
        });
      }

      // Clear the payer's in-flight guard: a pending out-row for this hold can
      // never settle now. Same finalize the card-tap reconciler uses.
      const pending = await db
        .select({ id: transactionsTable.id })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.paymentHash, inv.paymentHash),
            eq(transactionsTable.direction, "out"),
            eq(transactionsTable.status, "pending"),
          ),
        );
      for (const t of pending) {
        await finalizePendingSend(t.id, {
          status: "failed",
          reason: "Checkout closed by admin; the hold was cancelled and no payment arrived",
        }).catch(() => {});
      }

      await recordPaymentEventSync({
        paymentId: inv.id,
        accountId: inv.accountId,
        kind: "admin",
        event: "admin.cancel_hold",
        status: "success",
        mile: "first_mile",
        message: `Admin closed the checkout (hold cancelled, no funds moved)${
          pending.length ? `; ${pending.length} pending payer row(s) failed` : ""
        }`,
        paymentHash: inv.paymentHash,
        merchantPaymentHash: inv.merchantPaymentHash,
        amountSats: inv.amountSats,
        feeSats: inv.feeSats,
        detail: { before, after, closedPayerRows: pending.length },
      });

      return json(res, 200, { ok: true, before, after, closedPayerRows: pending.length });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : "Cancel failed" });
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
          failureSummary: tx.failureReason ? humanizeFailure(tx.failureReason).message : null,
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
