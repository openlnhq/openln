// Wrap driver: the single owner of "move open hold-wraps forward".
//
// Before this module every RIC status poll called advanceWrap() inline, which
// is one NWC lookup_invoice round-trip over a public Nostr relay per poll.
// Two devices polling every 2 s were enough to trip relay rate limits
// (2026-09-18 stress test: p99 poll latency 10 s, "Failed to connect to
// relay.getalby.com"). With 100 merchants that design cannot work.
//
// Now:
//   - HTTP status routes read the DB row and return in milliseconds.
//   - This driver advances open wraps from ONE place, at most one pass per
//     invoice per MIN_INTERVAL_MS, regardless of how many devices poll.
//   - kick(paymentHash) lets a poll or a wallet notification (see
//     nwcNotifications.ts) request an immediate pass without awaiting it.
//   - A slow sweep picks up anything nobody kicked (device offline, crash).
//
// advanceWrap() itself is untouched: every transition is CAS-guarded there, so
// a duplicate or concurrent kick is a harmless no-op. This module only decides
// WHEN to call it.
import { and, inArray, isNull, eq, asc } from "drizzle-orm";
import { db, pendingInvoicesTable } from "../db/index.js";
import { advanceWrap, cancelWrap, type WrapRow } from "./holdWrap.js";
import { relayInCooldown } from "./nwc.js";
import { emitAccountEvent } from "../events.js";
import { logger } from "./logger.js";

// States that still need the driver. settled/cancelled/needs_reconciliation
// are terminal for this loop (needs_reconciliation is a human job).
export const OPEN_WRAP_STATES = ["created", "accepted", "forwarding", "forwarded"] as const;

const MIN_INTERVAL_MS = 2_500;        // per-invoice floor between relay lookups
const SWEEP_INTERVAL_MS = 5_000;      // how often the loop looks for open wraps
const SWEEP_BATCH = 40;               // open wraps advanced per sweep (oldest first)
const MAX_CONCURRENT_ADVANCES = 4;    // relay requests in flight at once
// A `created` wrap nobody has asked about for this long is abandoned (device
// offline, cashier walked away without Cancel). Close it now instead of
// letting it sit on the Treasury until the 15 min hold expiry. cancelWrap
// re-checks the wallet first, so a customer paying at that exact moment is
// never cut off.
const ABANDON_AFTER_MS = 3 * 60 * 1000;
const lastInterest = new Map<string, number>();  // paymentHash -> last poll/kick

const lastPass = new Map<string, number>();       // paymentHash -> millis of last advance
const inFlight = new Set<string>();               // paymentHash currently advancing
const kicked = new Set<string>();                 // hashes asking for an immediate pass
let timer: NodeJS.Timeout | undefined;
let running = false;

type InvoiceRow = typeof pendingInvoicesTable.$inferSelect;

async function advanceOne(row: InvoiceRow, reason: string): Promise<string> {
  const hash = row.paymentHash;
  if (inFlight.has(hash)) return row.wrapStatus ?? "created";
  inFlight.add(hash);
  lastPass.set(hash, Date.now());
  try {
    const before = row.wrapStatus;
    const status = await advanceWrap(row as unknown as WrapRow);
    if (status !== before) {
      logger.info({ paymentHash: hash, from: before, to: status, reason }, "wrap driver: transition");
    }
    if (status === "settled") {
      emitAccountEvent(row.accountId, "payment", {
        paymentHash: hash, status: "paid", amountSats: row.amountSats, feeSats: row.feeSats ?? 0,
      });
      lastPass.delete(hash);
    }
    if (status === "cancelled" || status === "needs_reconciliation" || status === "settled") { lastPass.delete(hash); lastInterest.delete(hash); }
    return status;
  } catch (err) {
    logger.warn({ paymentHash: hash, err: err instanceof Error ? err.message : String(err) }, "wrap driver: advance failed");
    return row.wrapStatus ?? "created";
  } finally {
    inFlight.delete(hash);
  }
}

/** Ask for an immediate pass on one invoice. Never blocks the caller. */
export function kickWrap(paymentHash: string): void {
  if (!/^[0-9a-f]{64}$/.test(paymentHash)) return;
  lastInterest.set(paymentHash, Date.now());
  kicked.add(paymentHash);
  // Run soon, but coalesce bursts (several devices polling the same second).
  if (!timer) return;
  setTimeout(() => void drive("kick"), 0).unref();
}

/**
 * Advance one invoice NOW and return the resulting status. Used by wallet
 * notifications where we know something changed and want the forward to
 * start within the same tick. Honors the in-flight dedupe, not the interval.
 */
export async function advanceWrapNow(paymentHash: string, reason: string): Promise<string | undefined> {
  const [row] = await db.select().from(pendingInvoicesTable).where(eq(pendingInvoicesTable.paymentHash, paymentHash));
  if (!row || !row.wrapStatus || !(OPEN_WRAP_STATES as readonly string[]).includes(row.wrapStatus)) return row?.wrapStatus ?? undefined;
  return advanceOne(row, reason);
}

async function drive(reason: "sweep" | "kick"): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (relayInCooldown() && reason === "sweep") return;
    const rows = await db
      .select()
      .from(pendingInvoicesTable)
      .where(and(isNull(pendingInvoicesTable.paidAt), inArray(pendingInvoicesTable.wrapStatus, [...OPEN_WRAP_STATES])))
      .orderBy(asc(pendingInvoicesTable.createdAt))
      .limit(SWEEP_BATCH);

    const now = Date.now();
    // Abandoned checkouts: created, nobody polling, older than the window.
    // Also: a created hold past its own expiry can never be paid (the node
    // already dropped it), so close the row even while a device keeps polling.
    // Seen 2026-09-19 on dev: a relay outage hid two unpaid duplicates; one
    // was abandoned by the cleanup, the other stayed "created" because the
    // RIC never stopped polling it.
    for (const r of rows) {
      if (r.wrapStatus !== "created" || inFlight.has(r.paymentHash)) continue;
      const interest = lastInterest.get(r.paymentHash) ?? r.createdAt.getTime();
      const expired = r.expiresAt.getTime() < now;
      if (!expired && now - interest < ABANDON_AFTER_MS) continue;
      inFlight.add(r.paymentHash);
      try {
        const status = await cancelWrap(r as unknown as WrapRow, expired ? "expired" : "abandoned");
        if (status === "cancelled") { lastPass.delete(r.paymentHash); lastInterest.delete(r.paymentHash); }
      } catch (err) {
        logger.warn({ paymentHash: r.paymentHash, err: err instanceof Error ? err.message : String(err) }, "wrap driver: abandon cleanup failed");
      } finally { inFlight.delete(r.paymentHash); }
    }
    const due = rows.filter((r) => {
      if (inFlight.has(r.paymentHash)) return false;
      if (kicked.has(r.paymentHash)) return true;
      const last = lastPass.get(r.paymentHash) ?? 0;
      return now - last >= MIN_INTERVAL_MS;
    });
    for (const r of due) kicked.delete(r.paymentHash);
    // Anything kicked that is no longer open (settled by another path) is dropped.
    for (const h of [...kicked]) if (!rows.some((r) => r.paymentHash === h)) kicked.delete(h);

    // Bounded concurrency: a few relay requests at once, never a stampede.
    for (let i = 0; i < due.length; i += MAX_CONCURRENT_ADVANCES) {
      await Promise.all(due.slice(i, i + MAX_CONCURRENT_ADVANCES).map((r) => advanceOne(r, reason)));
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "wrap driver: sweep failed");
  } finally {
    running = false;
  }
}

export function startWrapDriver(): () => void {
  if (timer) return () => {};
  timer = setInterval(() => void drive("sweep"), SWEEP_INTERVAL_MS);
  timer.unref();
  void drive("sweep");
  logger.info({ sweepMs: SWEEP_INTERVAL_MS, minIntervalMs: MIN_INTERVAL_MS }, "wrap driver started");
  return () => { if (timer) clearInterval(timer); timer = undefined; };
}

/** Test/ops visibility. */
export function wrapDriverStats() {
  return { tracked: lastPass.size, watched: lastInterest.size, inFlight: inFlight.size, kicked: kicked.size, running };
}
