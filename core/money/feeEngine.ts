// @ts-nocheck
//
import { db } from "../db/index.js";
import { transactionsTable, pendingInvoicesTable } from "../db/index.js";
import { and, eq, isNotNull, or, inArray } from "drizzle-orm";
import { payInvoice, makeInvoice, getAccountNwcUrl, isAmbiguousPayError, lookupOutgoingPayment, lookupInvoice, PLATFORM_NWC_URL } from "./nwc.js";
import { advanceWrap, type WrapRow } from "./holdWrap.js";
import { extractPaymentHash } from "./lnAddress.js";
import { logger } from "./logger.js";
import { recordPaymentEvent } from "./paymentLog.js";

/**
 * Thrown when a payment's outcome is UNKNOWN: the pay request may have reached
 * the wallet even though no reply came back (relay reply/publish timeout).
 * The local transaction row stays "pending" - callers must resolve the true
 * outcome (resolveAmbiguousPayment / background reconcile) and must NEVER
 * retry the payment or report definitive failure.
 */
export class AmbiguousPaymentError extends Error {
  readonly pendingTxId: string;
  readonly bolt11: string;
  constructor(pendingTxId: string, bolt11: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "AmbiguousPaymentError";
    this.pendingTxId = pendingTxId;
    this.bolt11 = bolt11;
  }
}

// Veil collects its own fee on every outgoing payment.
// bitPOS reports 0 platform fee - all custody and fee handling is Veil's responsibility.
export function calculateFee(amountSats: number): {
  feeSats: number;
  bankSats: number;
  totalDeducted: number;
} {
  return { feeSats: 0, bankSats: 0, totalDeducted: amountSats };
}

/**
 * Process an outbound Lightning payment via the user's personal Veil wallet.
 *
 * Veil payments are atomic - they either succeed or fail with an error.
 * No DB balance manipulation is performed; Veil is the source of truth for balances.
 * A local transaction record is kept for UI history display only.
 */
export async function processExternalPayment(
  accountId: string,
  bolt11: string,
  amountSats: number,
  counterpartLnAddress?: string,
  memo?: string,
  nwcUrl?: string,
  cardId?: string,
): Promise<{ paymentHash: string; feeSats: number }> {
  const walletUrl = nwcUrl ?? await getAccountNwcUrl(accountId);
  if (!walletUrl) throw new Error("No wallet configured for this account");

  // Decode the payment hash up front and store it on the pending row - the
  // reconciler resolves ambiguous outcomes by hash (Veil ignores invoice-string
  // lookups), so it must never depend on re-decoding succeeding later.
  let decodedHash: string | null = null;
  try {
    decodedHash = extractPaymentHash(bolt11);
  } catch (err) {
    logger.warn({ accountId, err: err instanceof Error ? err.message : String(err) }, "Could not extract payment hash from bolt11");
  }

  const [pendingTx] = await db
    .insert(transactionsTable)
    .values({
      accountId,
      direction: "out",
      amountSats,
      feeSats: 0,
      type: "send",
      counterpartLnAddress,
      bolt11,
      paymentHash: decodedHash,
      status: "pending",
      memo,
      cardId: cardId ?? null,
    })
    .returning({ id: transactionsTable.id });

  // Single relay call per tap. Extra concurrent relay traffic (settlement
  // polls, balance reads) on the flaky Veil relay is what pushed the card-tap
  // response past the POS device's HTTP timeout (-11). pay_invoice is the only
  // relay op here; if its reply is dropped/slow the outcome is handled as
  // ambiguous below and the background reconciler finalizes by payment_hash.
  const payStarted = Date.now();
  recordPaymentEvent({
    paymentId: pendingTx.id,
    accountId,
    kind: cardId ? "card" : "send",
    event: "nwc.pay_invoice.start",
    status: "pending",
    message: `pay_invoice starting for ${amountSats} sats`,
    method: "pay_invoice",
    paymentHash: decodedHash,
    amountSats,
    detail: { cardId: cardId ?? null, counterpartLnAddress: counterpartLnAddress ?? null },
  });
  try {
    const payResult = await payInvoice(bolt11, walletUrl);

    await finalizePendingSend(pendingTx.id, {
      status: "completed",
      paymentHash: payResult.paymentHash,
      feeSats: payResult.feesPaidSats,
    });

    recordPaymentEvent({
      paymentId: pendingTx.id,
      accountId,
      kind: cardId ? "card" : "send",
      event: "nwc.pay_invoice.success",
      status: "success",
      message: `pay_invoice settled ${amountSats} sats (fee ${payResult.feesPaidSats})`,
      method: "pay_invoice",
      paymentHash: payResult.paymentHash,
      amountSats,
      feeSats: payResult.feesPaidSats,
      durationMs: Date.now() - payStarted,
    });

    logger.info(
      { accountId, amountSats, feeSats: payResult.feesPaidSats, paymentHash: payResult.paymentHash },
      "External payment processed via user wallet",
    );

    return { paymentHash: payResult.paymentHash, feeSats: payResult.feesPaidSats };
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : String(err);
    if (isAmbiguousPayError(err)) {
      // Outcome unknown - the wallet may have executed the payment. Keep the
      // row pending; resolveAmbiguousPayment / the background reconciler will
      // finalize it. Marking it failed here is what caused real double-charges.
      await db
        .update(transactionsTable)
        .set({ failureReason: `outcome unknown: ${failureReason}` })
        .where(and(eq(transactionsTable.id, pendingTx.id), eq(transactionsTable.status, "pending")))
        .catch((dbErr) =>
          logger.error({ dbErr, pendingTxId: pendingTx.id }, "Failed to annotate ambiguous transaction"),
        );
      recordPaymentEvent({
        paymentId: pendingTx.id,
        accountId,
        kind: cardId ? "card" : "send",
        event: "nwc.pay_invoice.ambiguous",
        status: "ambiguous",
        message: `pay_invoice ambiguous — left pending for resolution`,
        method: "pay_invoice",
        paymentHash: decodedHash,
        amountSats,
        durationMs: Date.now() - payStarted,
        errorClass: "ambiguous",
        errorMessage: failureReason,
      });
      logger.warn(
        { accountId, amountSats, pendingTxId: pendingTx.id, err: failureReason },
        "External payment outcome ambiguous - left pending for resolution",
      );
      throw new AmbiguousPaymentError(pendingTx.id, bolt11, err);
    }
    // CAS-guarded: if the settlement poll completed the row concurrently, a
    // definitive-looking failure reply must not overwrite it.
    const connFail = /failed to connect|econnrefused|enotfound|econnreset|websocket is not open/i.test(failureReason);
    recordPaymentEvent({
      paymentId: pendingTx.id,
      accountId,
      kind: cardId ? "card" : "send",
      event: "nwc.pay_invoice.fail",
      status: "fail",
      message: connFail
        ? `pay_invoice failed — wallet relay unreachable (no request sent)`
        : `pay_invoice failed definitively`,
      method: "pay_invoice",
      paymentHash: decodedHash,
      amountSats,
      durationMs: Date.now() - payStarted,
      errorClass: connFail ? "connection_fail" : "definitive_fail",
      errorMessage: failureReason,
    });
    await finalizePendingSend(pendingTx.id, { status: "failed", reason: failureReason }).catch((dbErr) =>
      logger.error({ dbErr, pendingTxId: pendingTx.id }, "Failed to mark transaction as failed"),
    );
    throw err;
  }
}

// ── Ambiguous-outcome resolution ─────────────────────────────────────────────

export type PendingSendOutcome =
  | { status: "completed"; paymentHash?: string; feeSats?: number }
  | { status: "failed"; reason: string };

/**
 * Finalize a pending send transaction. CAS-guarded on status='pending' so a
 * concurrent resolver/reconciler cannot double-finalize. Returns true if this
 * call performed the transition.
 */
export async function finalizePendingSend(txId: string, outcome: PendingSendOutcome): Promise<boolean> {
  const [row] = await db
    .update(transactionsTable)
    .set(
      outcome.status === "completed"
        ? {
            status: "completed",
            failureReason: null,
            ...(outcome.paymentHash ? { paymentHash: outcome.paymentHash } : {}),
            ...(outcome.feeSats !== undefined ? { feeSats: outcome.feeSats } : {}),
          }
        : { status: "failed", failureReason: outcome.reason },
    )
    .where(and(eq(transactionsTable.id, txId), eq(transactionsTable.status, "pending")))
    .returning({ id: transactionsTable.id });
  return !!row;
}

const AMBIGUOUS_RESOLVE_WINDOW_MS = 12_000;
const AMBIGUOUS_POLL_INTERVAL_MS = 3_000;

/**
 * In-network settlement fast path: when the paid bolt11 is one of our own
 * platform invoices (bitPOS merchant, incl. hold-invoice wraps), our own DB
 * settlement record is authoritative proof the payment succeeded - no relay
 * round-trip needed. Returns the payment hash when settled, null otherwise.
 */
/**
 * Authoritative proof that a bolt11 we issued received the customer's payment.
 *
 * DIRECT invoices: paidAt set.
 * HOLD WRAPS: once the platform hold is `accepted` the customer's HTLC is
 * locked on Alby — payment success for the payer even before 2nd-mile settle.
 * Using only wrapStatus=settled left ambiguous card/pays stuck ~60s+ and made
 * users look unpaid while funds were already locked on the hold.
 */
export async function checkOwnSettlementProof(paymentHash: string | null): Promise<string | null> {
  if (!paymentHash) return null;

  const [row] = await db
    .select({
      id: pendingInvoicesTable.id,
      wrapStatus: pendingInvoicesTable.wrapStatus,
      paidAt: pendingInvoicesTable.paidAt,
      accountId: pendingInvoicesTable.accountId,
      paymentHash: pendingInvoicesTable.paymentHash,
      merchantPaymentHash: pendingInvoicesTable.merchantPaymentHash,
      merchantBolt11: pendingInvoicesTable.merchantBolt11,
      amountSats: pendingInvoicesTable.amountSats,
      feeSats: pendingInvoicesTable.feeSats,
      memo: pendingInvoicesTable.memo,
      bolt11: pendingInvoicesTable.bolt11,
      preimage: pendingInvoicesTable.preimage,
      holdPreimage: pendingInvoicesTable.holdPreimage,
      wrapUpdatedAt: pendingInvoicesTable.wrapUpdatedAt,
      nwcUrlEncrypted: pendingInvoicesTable.nwcUrlEncrypted,
      expiresAt: pendingInvoicesTable.expiresAt,
    })
    .from(pendingInvoicesTable)
    .where(eq(pendingInvoicesTable.paymentHash, paymentHash))
    .limit(1);

  if (!row) return null;

  // Direct invoice already paid.
  if (row.paidAt) return paymentHash;

  // Wrap already past 1st mile in DB.
  if (
    row.wrapStatus &&
    ["accepted", "forwarding", "forwarded", "settled"].includes(row.wrapStatus)
  ) {
    return paymentHash;
  }

  // Wrap still "created" but customer may already have locked the hold on Alby.
  // That is payer-success; kick advanceWrap so 2nd mile runs without waiting for cron.
  if (row.wrapStatus && PLATFORM_NWC_URL) {
    try {
      const hold = await lookupInvoice(paymentHash, PLATFORM_NWC_URL);
      const locked =
        hold.state === "accepted" ||
        hold.state === "settled" ||
        (hold.paid && hold.state !== "failed");
      if (locked) {
        const wrapRow: WrapRow = {
          id: row.id,
          accountId: row.accountId,
          paymentHash: row.paymentHash,
          bolt11: row.bolt11,
          merchantBolt11: row.merchantBolt11,
          merchantPaymentHash: row.merchantPaymentHash,
          amountSats: row.amountSats,
          feeSats: row.feeSats,
          memo: row.memo,
          wrapStatus: row.wrapStatus,
          preimage: row.preimage,
          holdPreimage: row.holdPreimage,
          wrapUpdatedAt: row.wrapUpdatedAt,
          nwcUrlEncrypted: row.nwcUrlEncrypted,
          paidAt: row.paidAt,
          expiresAt: row.expiresAt,
        };
        // Fire-and-forget — advance is CAS-safe and dynamic.
        void advanceWrap(wrapRow);
        return paymentHash;
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), paymentHash },
        "checkOwnSettlementProof live hold lookup failed",
      );
    }
  }

  return null;
}

export type AmbiguousResolution =
  | { status: "completed"; paymentHash?: string; feeSats: number }
  | { status: "failed" }
  | { status: "pending" };

/**
 * Bounded poll to resolve an ambiguous payment before responding to the payer:
 * ask the paying wallet whether the invoice was actually paid.
 * - settled → finalize the tx as completed, return "completed"
 * - wallet reports state failed → finalize as failed, return "failed"
 * - anything else (including lookup NOT_FOUND, which can race the wallet's own
 *   record right after send) → keep polling until the window closes, then
 *   return "pending" and leave the row for the background reconciler.
 */
export async function resolveAmbiguousPayment(
  err: AmbiguousPaymentError,
  nwcUrl: string | undefined,
): Promise<AmbiguousResolution> {
  const deadline = Date.now() + AMBIGUOUS_RESOLVE_WINDOW_MS;
  let paymentHash: string | null = null;
  try {
    paymentHash = extractPaymentHash(err.bolt11);
  } catch { /* non-standard invoice - relay lookup only */ }
  for (;;) {
    // In-network fast path: our own settled invoice record proves success
    // without a relay round-trip.
    try {
      const proven = await checkOwnSettlementProof(paymentHash);
      if (proven) {
        await finalizePendingSend(err.pendingTxId, { status: "completed", paymentHash: proven });
        logger.info({ txId: err.pendingTxId, paymentHash: proven }, "Ambiguous payment resolved: settled (own invoice record)");
        return { status: "completed", paymentHash: proven, feeSats: 0 };
      }
    } catch (dbErr) {
      logger.warn({ txId: err.pendingTxId, dbErr }, "Own-settlement proof check failed");
    }
    try {
      const inv = await lookupOutgoingPayment(err.bolt11, nwcUrl);
      if (inv.paid) {
        const feeSats = Math.ceil((inv.feesPaidMsats ?? 0) / 1000);
        await finalizePendingSend(err.pendingTxId, { status: "completed", paymentHash: inv.paymentHash, feeSats });
        logger.info({ txId: err.pendingTxId, paymentHash: inv.paymentHash }, "Ambiguous payment resolved: settled");
        return { status: "completed", paymentHash: inv.paymentHash, feeSats };
      }
      if (inv.state === "failed") {
        await finalizePendingSend(err.pendingTxId, { status: "failed", reason: "Wallet reported payment failed" });
        logger.info({ txId: err.pendingTxId }, "Ambiguous payment resolved: failed");
        return { status: "failed" };
      }
    } catch (lookupErr) {
      logger.warn(
        { txId: err.pendingTxId, err: lookupErr instanceof Error ? lookupErr.message : String(lookupErr) },
        "Ambiguous payment lookup attempt failed - will retry within window",
      );
    }
    if (Date.now() + AMBIGUOUS_POLL_INTERVAL_MS > deadline) return { status: "pending" };
    await new Promise((r) => setTimeout(r, AMBIGUOUS_POLL_INTERVAL_MS));
  }
}

/**
 * Process an in-network payment between two bitPOS accounts via Veil.
 *
 * Creates a real Lightning invoice on the receiver's Veil wallet and pays it
 * from the sender's Veil wallet. Both sides get local transaction records.
 */
export async function processInternalPayment(
  senderAccountId: string,
  receiverAccountId: string,
  amountSats: number,
  senderHandle: string,
  receiverHandle: string,
  memo?: string,
): Promise<void> {
  const senderNwcUrl = await getAccountNwcUrl(senderAccountId);
  if (!senderNwcUrl) throw new Error("No wallet configured for sender");

  const receiverNwcUrl = await getAccountNwcUrl(receiverAccountId);
  if (!receiverNwcUrl) throw new Error("No wallet configured for receiver");

  const invoiceDesc = memo ?? `From ${senderHandle}`;
  const invoiceResult = await makeInvoice(amountSats, invoiceDesc, 300, receiverNwcUrl);

  const [sendTx] = await db
    .insert(transactionsTable)
    .values({
      accountId: senderAccountId,
      direction: "out",
      amountSats,
      feeSats: 0,
      type: "internal_send",
      counterpartHandle: receiverHandle,
      status: "pending",
      memo,
    })
    .returning({ id: transactionsTable.id });

  try {
    const payResult = await payInvoice(invoiceResult.bolt11, senderNwcUrl);

    await db
      .update(transactionsTable)
      .set({
        status: "completed",
        paymentHash: payResult.paymentHash,
        feeSats: payResult.feesPaidSats,
      })
      .where(eq(transactionsTable.id, sendTx.id));

    await db.insert(transactionsTable).values({
      accountId: receiverAccountId,
      direction: "in",
      amountSats,
      feeSats: 0,
      type: "internal_receive",
      counterpartHandle: senderHandle,
      status: "completed",
      paymentHash: payResult.paymentHash,
      bolt11: invoiceResult.bolt11,
      memo,
    });

    logger.info({ senderAccountId, receiverAccountId, amountSats }, "Internal payment settled via Veil");
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : String(err);
    await db
      .update(transactionsTable)
      .set({ status: "failed", failureReason })
      .where(eq(transactionsTable.id, sendTx.id))
      .catch(() => {});
    throw new Error(`Payment failed: ${failureReason}`);
  }
}
