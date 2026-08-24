// @ts-nocheck
//
/**
 * Incoming-fee wrap engine (1% in, 0% out).
 *
 * A POS sale for price P produces ONE wrapped invoice for P:
 *   1. bitPOS generates a random preimage; the platform fee wallet (Alby,
 *      hold-invoice capable) mints a hold invoice for P whose payment hash is
 *      sha256 of that preimage.
 *   2. The merchant's wallet mints a real invoice for P minus fee, with its
 *      own (different) payment hash.
 *   3. The customer pays the hold invoice - the payment is held, never
 *      credited to bitPOS yet.
 *   4. Once the hold is accepted, the platform wallet pays the merchant
 *      invoice (a normal payment - different hash, so no conflict with the
 *      node's own hold), then settles the hold with the generated preimage.
 *      The spread stays with bitPOS.
 *   5. If the merchant payment fails definitively, the hold is cancelled and
 *      the customer's sats refund automatically. The merchant is always paid
 *      BEFORE the hold is settled, so the customer can never lose funds; the
 *      only bounded platform risk is a crash between forward and settle,
 *      which recovery closes by settling with the persisted preimage.
 *
 * Why not the classic same-hash wrap (settle with the preimage returned by
 * paying the merchant invoice)? The platform node runs LDK, which keys its
 * payment store by payment hash: any outgoing payment whose hash matches the
 * node's own hold invoice is rejected with DuplicatePayment. Verified live -
 * a single-node deployment cannot forward its own wrapped hash. Alby's
 * sandbox demo only works because its demo wallets share custodial infra.
 *
 * State machine (pending_invoices.wrap_status):
 *   created -> accepted -> forwarding -> forwarded -> settled
 *                      \-> cancelled            \-> needs_reconciliation
 *
 * Production runs on autoscale, so every transition is reachable from a
 * request-driven poll (status endpoint, reconcile sweeps, fallback cron).
 * Push notifications are an optional accelerator only.
 */
import { createHash, randomBytes } from "crypto";
import { db } from "@workspace/db";
import { pendingInvoicesTable, transactionsTable } from "@workspace/db";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  makeInvoice,
  makeHoldInvoice,
  settleHoldInvoice,
  cancelHoldInvoice,
  payInvoice,
  lookupInvoice,
  resolveNwcUrl,
  paymentHashFromPreimage,
  getBalance,
  PLATFORM_NWC_URL,
  relayInCooldown,
} from "./nwc";
import { logger } from "./logger";
import { recordPaymentEvent } from "./paymentLog";

// Customer-facing hold invoice expiry - short, consistent with POS usage
// (customer is standing at the terminal). Limits open-hold exposure.
const WRAP_EXPIRY_SECONDS = 15 * 60;
// Merchant invoice must outlive the wrap so forwarding never hits an expired
// invoice even at the edge of the wrap window.
const MERCHANT_EXPIRY_SECONDS = 60 * 60;
// Cap concurrent unsettled holds to prevent HTLC-slot griefing of the
// platform wallet. Beyond the cap, sales fall back to direct (unwrapped).
const MAX_OPEN_WRAPS = 25;
// A 'forwarding' claim older than this is presumed crashed - recovery kicks in.
const FORWARD_STALE_MS = 90 * 1000;
// After this long stuck in forwarding with no resolution, flag for manual review.
const FORWARD_ABANDON_MS = 30 * 60 * 1000;

/** 1% incoming fee: max(1 sat, ceil(1%)), clamped so the merchant always gets >= 1 sat. */
export function incomingFeeSats(amountSats: number): number {
  return Math.min(Math.max(1, Math.ceil(amountSats * 0.01)), Math.max(0, amountSats - 1));
}

export interface WrappedInvoice {
  bolt11: string; // customer-facing hold invoice
  paymentHash: string; // hold hash = sha256(holdPreimage)
  holdPreimage: string; // platform-generated settle preimage (hex)
  merchantBolt11: string;
  merchantPaymentHash: string; // merchant invoice's own hash (differs from paymentHash)
  feeSats: number;
  expiresAt: Date;
}

const OPEN_WRAP_STATES = ["created", "accepted", "forwarding", "forwarded"] as const;

async function openWrapStats(): Promise<{ count: number; obligationSats: number }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      obligationSats: sql<number>`coalesce(sum(case when ${pendingInvoicesTable.wrapStatus} in ('created','accepted','forwarding') then ${pendingInvoicesTable.amountSats} - coalesce(${pendingInvoicesTable.feeSats}, 0) else 0 end), 0)::int`,
    })
    .from(pendingInvoicesTable)
    .where(
      and(
        inArray(pendingInvoicesTable.wrapStatus, [...OPEN_WRAP_STATES]),
        gt(pendingInvoicesTable.expiresAt, new Date(Date.now() - 60 * 60 * 1000)),
      ),
    );
  return { count: row?.count ?? 0, obligationSats: row?.obligationSats ?? 0 };
}

// Liquidity preflight: the platform wallet pays the merchant BEFORE the held
// customer payment is credited (credit happens at settle), so every wrap
// requires float. Balance is cached briefly to avoid a wallet round-trip on
// every sale; outstanding obligations are subtracted from the cached figure.
const BALANCE_CACHE_TTL_MS = 30 * 1000;
// Routing-fee headroom per forward, on top of the merchant amount.
const FLOAT_MARGIN_SATS = 10;
let cachedPlatformBalance: { sats: number; at: number } | null = null;

async function platformBalanceSats(): Promise<number> {
  const now = Date.now();
  if (cachedPlatformBalance && now - cachedPlatformBalance.at < BALANCE_CACHE_TTL_MS) {
    return cachedPlatformBalance.sats;
  }
  const { balanceSats } = await getBalance(PLATFORM_NWC_URL);
  cachedPlatformBalance = { sats: balanceSats, at: now };
  return balanceSats;
}

/**
 * Create a wrapped invoice for a POS sale. Returns null when wrapping is not
 * possible (no platform wallet, fee rounds to zero, open-hold cap reached, or
 * the platform wallet call fails) - the caller falls back to a direct invoice
 * so the sale is never blocked.
 */
export async function createWrappedInvoice(
  amountSats: number,
  memo: string,
  merchantNwcUrl: string | undefined,
): Promise<WrappedInvoice | null> {
  if (!PLATFORM_NWC_URL || !merchantNwcUrl) return null;

  const feeSats = incomingFeeSats(amountSats);
  if (feeSats < 1) return null; // 1-sat sale - nothing to wrap

  try {
    const { count, obligationSats } = await openWrapStats();
    if (count >= MAX_OPEN_WRAPS) {
      logger.warn({ cap: MAX_OPEN_WRAPS }, "Open wrap cap reached - falling back to direct invoice");
      return null;
    }

    // Liquidity gate: the forward is paid from float before the held funds
    // are credited. Without enough float the customer would pay and the sale
    // would then fail at the forward step - fall back to direct instead.
    const merchantSats = amountSats - feeSats;
    const required = obligationSats + merchantSats + FLOAT_MARGIN_SATS;
    const balance = await platformBalanceSats();
    if (balance < required) {
      logger.warn(
        { balance, required, obligationSats, merchantSats },
        "Platform float insufficient for wrap - falling back to direct invoice",
      );
      return null;
    }

    const merchant = await makeInvoice(
      amountSats - feeSats,
      memo,
      MERCHANT_EXPIRY_SECONDS,
      merchantNwcUrl,
    );

    // Platform-generated preimage: the hold's hash is OURS, unrelated to the
    // merchant invoice, so forwarding is a normal payment on the same node.
    const holdPreimage = randomBytes(32).toString("hex");
    const holdHash = createHash("sha256").update(Buffer.from(holdPreimage, "hex")).digest("hex");

    const hold = await makeHoldInvoice(
      amountSats,
      memo,
      holdHash,
      WRAP_EXPIRY_SECONDS,
      PLATFORM_NWC_URL,
    );

    if (hold.paymentHash !== holdHash) {
      // Platform wallet did not honor the requested hash - never expose this
      // invoice (we could not settle it).
      cancelHoldInvoice(hold.paymentHash, PLATFORM_NWC_URL).catch(() => {});
      logger.error(
        { requestedHash: holdHash, holdHash: hold.paymentHash },
        "Hold invoice hash mismatch - wallet ignored payment_hash, falling back to direct",
      );
      return null;
    }

    recordPaymentEvent({
      paymentId: holdHash,
      kind: "wrap",
      event: "wrap.hold_minted",
      status: "info",
      mile: "first_mile",
      message: `Hold minted for ${amountSats} sats (fee ${feeSats}); merchant invoice ready`,
      paymentHash: holdHash,
      merchantPaymentHash: merchant.paymentHash,
      amountSats,
      feeSats,
      detail: { merchantSats: amountSats - feeSats },
    });
    return {
      bolt11: hold.bolt11,
      paymentHash: holdHash,
      holdPreimage,
      merchantBolt11: merchant.bolt11,
      merchantPaymentHash: merchant.paymentHash,
      feeSats,
      expiresAt: hold.expiresAt,
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Wrapped invoice creation failed - falling back to direct invoice",
    );
    return null;
  }
}

// ── State machine ────────────────────────────────────────────────────────────

export type WrapRow = {
  id: string;
  accountId: string;
  paymentHash: string; // hold hash (customer-facing)
  bolt11: string;
  merchantBolt11: string | null;
  merchantPaymentHash: string | null; // null on legacy same-hash rows
  amountSats: number;
  feeSats: number | null;
  memo: string | null;
  wrapStatus: string | null;
  preimage: string | null; // merchant-payment preimage (audit trail)
  holdPreimage: string | null; // platform-generated settle preimage; null on legacy rows
  wrapUpdatedAt: Date | null;
  nwcUrlEncrypted: string | null;
  paidAt: Date | null;
  expiresAt: Date;
};

function isDefinitivePayFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // NWC error codes / messages that mean the payment definitively did NOT go
  // through and never will: safe to cancel the hold. "already paid" is
  // deliberately NOT here - it can mean a prior attempt SUCCEEDED, so it must
  // be resolved by checking the merchant side, never by cancelling.
  return /payment_failed|no.?route|route not found|insufficient.?balance|invoice.?(is.)?expired|self.?payment|quota|budget/i.test(msg);
}

function isAlreadyPaidError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // "duplicate payment" belongs here too: on LDK it means an outgoing payment
  // with this hash was already initiated - possibly one that SUCCEEDED (or is
  // still in flight). Like "already paid", it must be resolved by checking
  // the outgoing payment's actual state, never by cancelling blindly.
  return /already.?paid|invoice.?(is.)?paid|duplicate.?payment/i.test(msg);
}

function isAlreadySettledError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already settled|invoice.?settled|not.?(a.)?hold|wrong invoice state/i.test(msg);
}

function isAlreadyCancelledError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // The hold no longer exists or already reached a terminal state - the
  // customer's HTLC (if any) has been or will be failed back. Treat as done.
  return /already.?cancel|cancell?ed|not.?found|expired|no.?such|wrong invoice state/i.test(msg);
}

/** Re-read the row's current wrap status (CAS lost to a concurrent advance). */
async function currentWrapStatus(id: string, fallback: string): Promise<string> {
  const [row] = await db
    .select({ wrapStatus: pendingInvoicesTable.wrapStatus })
    .from(pendingInvoicesTable)
    .where(eq(pendingInvoicesTable.id, id));
  return row?.wrapStatus ?? fallback;
}

/** Cancel the hold; tolerate "already cancelled/expired/not found" as success. */
async function cancelHoldTolerant(paymentHash: string): Promise<void> {
  try {
    await cancelHoldInvoice(paymentHash, PLATFORM_NWC_URL!);
  } catch (err) {
    if (!isAlreadyCancelledError(err)) throw err;
  }
}

/**
 * Check the platform node's OWN record of the outgoing merchant payment.
 * This is the authoritative forward-state source: it works even when the
 * merchant's wallet (e.g. Primal) never reports settlement over NWC.
 * Returns "settled" | "failed" | "pending" | "unknown".
 */
async function platformOutgoingState(merchantHash: string): Promise<{ state: string; preimage?: string }> {
  try {
    const inv = await lookupInvoice(merchantHash, PLATFORM_NWC_URL);
    if (inv.type && inv.type !== "outgoing") return { state: "unknown" };
    if (inv.state === "settled" || inv.preimage) return { state: "settled", preimage: inv.preimage };
    if (inv.state === "failed") return { state: "failed" };
    if (inv.state === "pending" || inv.state === "accepted") return { state: "pending" };
    return { state: "unknown" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not.?found|no.?such/i.test(msg)) return { state: "failed" }; // never initiated
    return { state: "unknown" };
  }
}

async function setWrapStatus(
  id: string,
  from: string[],
  to: string,
  extra: Partial<{ preimage: string; paidAt: Date }> = {},
): Promise<boolean> {
  const [row] = await db
    .update(pendingInvoicesTable)
    .set({ wrapStatus: to, wrapUpdatedAt: new Date(), ...extra })
    .where(and(eq(pendingInvoicesTable.id, id), inArray(pendingInvoicesTable.wrapStatus, from)))
    .returning({
      id: pendingInvoicesTable.id,
      accountId: pendingInvoicesTable.accountId,
      paymentHash: pendingInvoicesTable.paymentHash,
      merchantPaymentHash: pendingInvoicesTable.merchantPaymentHash,
      amountSats: pendingInvoicesTable.amountSats,
      feeSats: pendingInvoicesTable.feeSats,
    });
  if (row) {
    const mile =
      to === "created" || to === "accepted"
        ? "first_mile"
        : to === "forwarding" || to === "forwarded"
          ? "last_mile"
          : "both";
    const status =
      to === "settled"
        ? "success"
        : to === "cancelled"
          ? "fail"
          : to === "needs_reconciliation"
            ? "ambiguous"
            : to === "forwarding"
              ? "pending"
              : "info";
    recordPaymentEvent({
      paymentId: id,
      accountId: row.accountId,
      kind: "wrap",
      event: `wrap.transition.${to}`,
      status: status as "success" | "fail" | "ambiguous" | "pending" | "info",
      mile: mile as "first_mile" | "last_mile" | "both",
      message: `Wrap ${from.join("|")} → ${to}`,
      paymentHash: row.paymentHash,
      merchantPaymentHash: row.merchantPaymentHash,
      amountSats: row.amountSats,
      feeSats: row.feeSats,
      detail: { from, to, hasPreimage: !!extra.preimage },
    });
  }
  return !!row;
}

/** Record the settled sale: merchant receives amount minus fee; fee is the bitPOS spread. */
async function finalizeSettled(row: WrapRow): Promise<void> {
  const feeSats = row.feeSats ?? 0;
  await db.transaction(async (tx) => {
    // Include "created": hold can settle after crash recovery when we already
    // hold the settle preimage (early-settle path). Without it the merchant
    // receive ledger is silently dropped.
    const [marked] = await tx
      .update(pendingInvoicesTable)
      .set({ wrapStatus: "settled", wrapUpdatedAt: new Date(), paidAt: row.paidAt ?? new Date() })
      .where(
        and(
          eq(pendingInvoicesTable.id, row.id),
          inArray(pendingInvoicesTable.wrapStatus, [
            "created",
            "forwarded",
            "forwarding",
            "accepted",
            "needs_reconciliation",
          ]),
        ),
      )
      .returning({ id: pendingInvoicesTable.id });
    if (!marked) return;

    await tx.insert(transactionsTable).values({
      accountId: row.accountId,
      direction: "in",
      amountSats: row.amountSats - feeSats,
      feeSats,
      type: "receive",
      paymentHash: row.paymentHash,
      bolt11: row.merchantBolt11 ?? row.bolt11,
      status: "completed",
      memo: row.memo ?? undefined,
      fiatCurrency: row.fiatCurrency ?? undefined, fiatAmount: row.fiatAmount ?? undefined, fiatBaseRate: row.fiatBaseRate ?? undefined, fiatEffectiveRate: row.fiatEffectiveRate ?? undefined, fiatModifier: row.fiatModifier ?? undefined, fiatRateSource: row.fiatRateSource ?? undefined, fiatRateDirection: row.fiatRateDirection ?? undefined, fiatRateAt: row.fiatRateAt ?? undefined,
    });
  });
  recordPaymentEvent({
    paymentId: row.id,
    accountId: row.accountId,
    kind: "wrap",
    event: "wrap.settled",
    status: "success",
    mile: "both",
    message: `Wrap settled — merchant ${row.amountSats - feeSats} sats, fee ${feeSats} sats captured`,
    paymentHash: row.paymentHash,
    merchantPaymentHash: row.merchantPaymentHash,
    amountSats: row.amountSats,
    feeSats,
  });
  logger.info(
    { invoiceId: row.id, accountId: row.accountId, amountSats: row.amountSats, feeSats },
    "Wrapped invoice settled - merchant paid, fee collected",
  );
}

// Dedupe concurrent advances per invoice (parallel polls, cron overlap).
const inflightAdvances = new Map<string, Promise<string>>();

/**
 * Drive a wrapped invoice's state machine forward one or more steps.
 * Returns the resulting wrap status. Safe to call from any request path -
 * every transition is CAS-guarded so concurrent callers cannot double-pay
 * or double-settle.
 */
export function advanceWrap(row: WrapRow): Promise<string> {
  const inflight = inflightAdvances.get(row.id);
  if (inflight) return inflight;
  const run = doAdvance(row)
    .catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err), invoiceId: row.id }, "advanceWrap error");
      return row.wrapStatus ?? "created";
    })
    .finally(() => inflightAdvances.delete(row.id));
  inflightAdvances.set(row.id, run);
  return run;
}

async function doAdvance(row: WrapRow): Promise<string> {
  let status = row.wrapStatus ?? "created";
  if (!PLATFORM_NWC_URL) return status;

  if (status === "settled" || status === "cancelled" || status === "needs_reconciliation") {
    return status;
  }

  // created: has the customer paid the hold invoice yet?
  if (status === "created") {
    let hold: Awaited<ReturnType<typeof lookupInvoice>>;
    try {
      hold = await lookupInvoice(row.paymentHash, PLATFORM_NWC_URL);
    } catch (err) {
      logger.warn(
        { invoiceId: row.id, err: err instanceof Error ? err.message : String(err) },
        "advanceWrap: platform hold lookup failed - will retry",
      );
      return status;
    }
    // accepted = customer HTLC locked (1st mile done). Some wallets surface
    // paid=true while still held; treat locked OR accepted as 1st-mile complete.
    if (hold.state === "accepted" || (hold.paid && hold.state !== "settled" && hold.state !== "failed")) {
      await setWrapStatus(row.id, ["created"], "accepted");
      status = "accepted";
    } else if (hold.state === "settled") {
      // Settled without our record progressing (prior instance died after
      // settle). Only bitPOS knows the hold preimage, so a settled hold means
      // we settled it - which only happens after the merchant was paid.
      if (row.holdPreimage || row.preimage) {
        await finalizeSettled(row);
        return "settled";
      }
      await setWrapStatus(row.id, ["created"], "needs_reconciliation");
      logger.error({ invoiceId: row.id }, "Hold settled but no preimage recorded - needs reconciliation");
      return "needs_reconciliation";
    } else if (hold.state === "failed" || row.expiresAt < new Date()) {
      await setWrapStatus(row.id, ["created"], "cancelled");
      return "cancelled";
    } else {
      return "created";
    }
  }

  // accepted: claim the forward step, pay the merchant invoice.
  if (status === "accepted") {
    const claimed = await setWrapStatus(row.id, ["accepted"], "forwarding");
    if (!claimed) return "forwarding"; // another caller owns the forward
    row.wrapUpdatedAt = new Date();
    status = "forwarding";

    if (!row.merchantBolt11) {
      await setWrapStatus(row.id, ["forwarding"], "needs_reconciliation");
      logger.error({ invoiceId: row.id }, "Wrap accepted but no merchant bolt11 stored");
      return "needs_reconciliation";
    }

    try {
      const pay = await payInvoice(row.merchantBolt11, PLATFORM_NWC_URL);
      const expectedHash = row.merchantPaymentHash ?? row.paymentHash;
      if (paymentHashFromPreimage(pay.preimage) !== expectedHash) {
        // Merchant IS paid (the wallet returned a preimage) - log the anomaly
        // but never strand the wrap: settlement uses the hold preimage.
        logger.error(
          { invoiceId: row.id, expectedHash },
          "Forward preimage does not match merchant payment hash - proceeding to settle",
        );
      }
      // Persist the merchant preimage BEFORE settling (audit + crash proof).
      const cas = await setWrapStatus(row.id, ["forwarding"], "forwarded", { preimage: pay.preimage });
      if (!cas) return currentWrapStatus(row.id, "forwarded"); // concurrent advance won - trust the DB
      row.preimage = pay.preimage;
      status = "forwarded";
    } catch (err) {
      if (isAlreadyPaidError(err)) {
        // "already paid" / "duplicate payment" may mean a PRIOR attempt
        // succeeded or is still in flight. Never cancel blindly - ask the
        // platform node for the outgoing payment's actual state.
        const merchantHash = row.merchantPaymentHash ?? row.paymentHash;
        const outgoing = await platformOutgoingState(merchantHash);
        if (outgoing.state === "settled") {
          await setWrapStatus(row.id, ["forwarding"], "forwarded", outgoing.preimage ? { preimage: outgoing.preimage } : {});
          row.preimage = outgoing.preimage ?? row.preimage;
          status = "forwarded";
        } else if (outgoing.state === "failed") {
          // Prior attempt failed permanently; on LDK the hash is burned, so a
          // retry can never succeed. Refund the customer.
          logger.warn({ invoiceId: row.id }, "Prior forward attempt failed permanently - cancelling hold");
          try {
            await cancelHoldTolerant(row.paymentHash);
            await setWrapStatus(row.id, ["forwarding"], "cancelled");
            return "cancelled";
          } catch (cancelErr) {
            logger.error({ invoiceId: row.id, err: cancelErr }, "Hold cancel failed after forward failure");
            return "forwarding"; // stale-recovery will retry the cancel
          }
        } else {
          // In flight or unknown - leave the claim; stale recovery resolves it.
          logger.warn({ invoiceId: row.id, outgoing: outgoing.state }, "Forward reported already initiated - awaiting resolution");
          return "forwarding";
        }
      } else if (isDefinitivePayFailure(err)) {
        logger.warn(
          { invoiceId: row.id, err: err instanceof Error ? err.message : String(err) },
          "Merchant forward failed definitively - cancelling hold",
        );
        try {
          await cancelHoldTolerant(row.paymentHash);
          await setWrapStatus(row.id, ["forwarding"], "cancelled");
          return "cancelled";
        } catch (cancelErr) {
          logger.error({ invoiceId: row.id, err: cancelErr }, "Hold cancel failed after forward failure");
          return "forwarding"; // stale-recovery will retry the cancel
        }
      } else {
        // Ambiguous (timeout, relay hiccup): the payment may still be in
        // flight. Leave the claim in place - stale recovery resolves it by
        // checking the merchant side.
        logger.warn(
          { invoiceId: row.id, err: err instanceof Error ? err.message : String(err) },
          "Merchant forward ambiguous - awaiting stale recovery",
        );
        return "forwarding";
      }
    }
  }

  // forwarding: a previous claim crashed or ended ambiguous. Resolve from the
  // platform node's own outgoing-payment record - the merchant's wallet may
  // never report settlement (e.g. Primal), but our node always knows whether
  // ITS payment settled or failed.
  if (status === "forwarding") {
    const claimedAt = row.wrapUpdatedAt?.getTime() ?? 0;
    const age = Date.now() - claimedAt;
    if (age < FORWARD_STALE_MS) return "forwarding";

    const merchantHash = row.merchantPaymentHash ?? row.paymentHash;
    let resolved = false;
    const outgoing = await platformOutgoingState(merchantHash);
    if (outgoing.state === "settled") {
      const cas = await setWrapStatus(row.id, ["forwarding"], "forwarded", outgoing.preimage ? { preimage: outgoing.preimage } : {});
      if (!cas) return currentWrapStatus(row.id, "forwarded"); // concurrent advance won - trust the DB
      row.preimage = outgoing.preimage ?? row.preimage;
      status = "forwarded";
      resolved = true;
    } else if (outgoing.state === "failed") {
      // The forward definitively failed (or was never initiated). On LDK the
      // hash is burned, so a retry can never succeed - refund the customer.
      await cancelHoldTolerant(row.paymentHash);
      await setWrapStatus(row.id, ["forwarding"], "cancelled");
      return "cancelled";
    }
    if (!resolved && status === "forwarding") {
      if (age > FORWARD_ABANDON_MS) {
        await setWrapStatus(row.id, ["forwarding"], "needs_reconciliation");
        logger.error({ invoiceId: row.id }, "Wrap stuck in forwarding - needs manual reconciliation");
        return "needs_reconciliation";
      }
      return "forwarding";
    }
  }

  // forwarded: merchant is paid - settle the hold with the platform-generated
  // preimage (legacy same-hash rows settle with the merchant preimage).
  // Retries on every poll until the wallet confirms.
  if (status === "forwarded") {
    const settlePreimage = row.holdPreimage ?? row.preimage;
    if (!settlePreimage) {
      await setWrapStatus(row.id, ["forwarded"], "needs_reconciliation");
      return "needs_reconciliation";
    }
    try {
      await settleHoldInvoice(settlePreimage, PLATFORM_NWC_URL);
    } catch (err) {
      if (!isAlreadySettledError(err)) {
        logger.warn(
          { invoiceId: row.id, err: err instanceof Error ? err.message : String(err) },
          "Hold settle failed - will retry on next poll",
        );
        return "forwarded";
      }
    }
    await finalizeSettled(row);
    return "settled";
  }

  return status;
}

/**
 * Advance a batch of wrapped invoices (reconcile sweeps / fallback cron).
 * Sequential on purpose - each advance may issue several NWC calls.
 */
export async function advanceWrapBatch(rows: WrapRow[]): Promise<void> {
  for (const row of rows) {
    if (relayInCooldown()) return;
    await advanceWrap(row);
  }
}
