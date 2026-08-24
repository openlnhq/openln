// @ts-nocheck
//
import cron from "node-cron";
import { db } from "@workspace/db";
import { pendingInvoicesTable, transactionsTable } from "@workspace/db";
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { NWCClient } from "@getalby/sdk";
import {
  lookupInvoice,
  lookupOutgoingPayment,
  listTransactions,
  resolveNwcUrl,
  relayInCooldown,
  noteRelayOverload,
  getAccountNwcUrl,
  isPaymentNotFoundError,
} from "./nwc";
import { finalizePendingSend, checkOwnSettlementProof } from "./feeEngine";
import { extractPaymentHash } from "./lnAddress";
import { advanceWrap, advanceWrapBatch, type WrapRow } from "./holdWrap";
import { checkLnurlVerify } from "./lnAddress";
import { logger } from "./logger";
import { autoSettleShopOrders, directSettleShopOrder } from "./shopOrderAutoSettle";

// ── Shared settlement logic ───────────────────────────────────────────────────

type PendingInvoiceRow = {
  id: string;
  accountId: string;
  paymentHash: string;
  bolt11: string;
  amountSats: number;
  memo: string | null;
  cardOrderId: string | null;
  paidAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  nwcUrlEncrypted: string | null;
  merchantBolt11: string | null;
  merchantPaymentHash: string | null;
  feeSats: number | null;
  wrapStatus: string | null;
  preimage: string | null;
  holdPreimage: string | null;
  lnurlVerifyUrl: string | null;
  wrapUpdatedAt: Date | null;
};

export async function settleInvoiceByPaymentHash(paymentHash: string, paidAt: Date): Promise<boolean> {
  const [invoice] = await db
    .select()
    .from(pendingInvoicesTable)
    .where(
      and(
        eq(pendingInvoicesTable.paymentHash, paymentHash),
        isNull(pendingInvoicesTable.paidAt),
      ),
    );

  if (!invoice) return false;
  if (invoice.wrapStatus) {
    // Wrapped (hold-invoice) rows settle only through the wrap state machine -
    // the merchant invoice being paid is a mid-flight step, not the end state.
    advanceWrap(invoice as WrapRow).catch(() => {});
    return false;
  }
  return settleInvoice(invoice as PendingInvoiceRow, paidAt);
}

async function settleInvoice(invoice: PendingInvoiceRow, paidAt: Date): Promise<boolean> {
  let settled = false;

  await db.transaction(async (tx) => {
    const [marked] = await tx
      .update(pendingInvoicesTable)
      .set({ paidAt })
      .where(
        and(
          eq(pendingInvoicesTable.id, invoice.id),
          isNull(pendingInvoicesTable.paidAt),
        ),
      )
      .returning({ id: pendingInvoicesTable.id });

    if (!marked) return;
    settled = true;

    if (invoice.cardOrderId) {
      // Shop-order invoice: bypass balance entirely - settle the order directly
      return;
    }

    // Record a receive transaction for local history display.
    // Balance is tracked by Veil - no DB balance_sats update needed.
    await tx.insert(transactionsTable).values({
      accountId: invoice.accountId,
      direction: "in",
      amountSats: invoice.amountSats,
      feeSats: 0,
      type: "receive",
      paymentHash: invoice.paymentHash,
      bolt11: invoice.bolt11,
      status: "completed",
      memo: invoice.memo ?? undefined,
      fiatCurrency: invoice.fiatCurrency ?? undefined, fiatAmount: invoice.fiatAmount ?? undefined, fiatBaseRate: invoice.fiatBaseRate ?? undefined, fiatEffectiveRate: invoice.fiatEffectiveRate ?? undefined, fiatModifier: invoice.fiatModifier ?? undefined, fiatRateSource: invoice.fiatRateSource ?? undefined, fiatRateDirection: invoice.fiatRateDirection ?? undefined, fiatRateAt: invoice.fiatRateAt ?? undefined,
    });
  });

  if (settled) {
    if (invoice.cardOrderId) {
      logger.info(
        { invoiceId: invoice.id, orderId: invoice.cardOrderId, amountSats: invoice.amountSats },
        "Shop order invoice settled - settling order directly",
      );
      directSettleShopOrder(invoice.cardOrderId, invoice.accountId).catch((err) =>
        logger.warn({ err, orderId: invoice.cardOrderId }, "directSettleShopOrder error"),
      );
    } else {
      logger.info(
        { invoiceId: invoice.id, accountId: invoice.accountId, amountSats: invoice.amountSats },
        "Invoice settled - transaction recorded",
      );
      autoSettleShopOrders(invoice.accountId).catch((err) =>
        logger.warn({ err, accountId: invoice.accountId }, "shopOrderAutoSettle error"),
      );
    }
  }

  return settled;
}

// ── On-demand per-account reconciliation ─────────────────────────────────────
// Autoscale deployments idle between requests, so the long-lived relay push
// subscription is unreliable in production. This request-driven sweep settles
// an account's unpaid invoices at the moment the client fetches history or
// balance - by definition the instance is awake when the user is looking.

const lastReconcileAt = new Map<string, number>(); // accountId → epoch ms
const inflightReconciles = new Map<string, Promise<void>>(); // accountId → running sweep
const RECONCILE_DEBOUNCE_MS = 5_000;
const RECONCILE_MAX_INVOICES = 10;
const RECONCILE_TIMEOUT_MS = 3_000;
// Keep checking invoices for a while after expiry - a paid invoice can only
// have been paid before it expired, so late settlement is always safe. This
// covers payments that landed while no instance was awake to settle them.
const EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000;
const SWEEP_MAX_INVOICES = 25;

// ── Batch invoice checking via list_transactions ─────────────────────────────
// One list_transactions request per wallet covers ALL of its pending invoices,
// instead of one lookup_invoice per invoice. This is the single biggest lever
// against relay rate limiting ("rate-limited: slow down" NOTICEs in prod).
// If a wallet does not support list_transactions, fall back to bounded
// per-invoice lookups for that wallet only.

const walletsWithoutListTx = new Set<string>(); // nwcUrl → list_transactions unsupported

function isUnsupportedMethodError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not.?implemented|not.?supported|not.?found|unknown method|restricted|unauthorized/i.test(msg);
}

/**
 * Check a batch of pending invoices for settlement, grouped by wallet.
 * Makes at most one relay request per wallet (plus a bounded lookup fallback).
 */
async function checkInvoiceBatch(invoices: PendingInvoiceRow[], context: string): Promise<void> {
  // Wrapped (hold-invoice) rows advance through their own state machine -
  // exclude them from the merchant-wallet lookup path entirely.
  const wrapped = invoices.filter((inv) => inv.wrapStatus);
  if (wrapped.length > 0) {
    await advanceWrapBatch(wrapped as WrapRow[]).catch((err) =>
      logger.warn({ err }, `${context}: wrap batch error`),
    );
  }
  invoices = invoices.filter((inv) => !inv.wrapStatus);

  // Lightning-address rows settle via their LUD-21 verify URL (plain HTTPS,
  // no relay involved) - handle them before the NWC wallet grouping.
  const lnurlRows = invoices.filter((inv) => inv.lnurlVerifyUrl);
  const LNURL_CHECK_CAP = 10;
  for (const inv of lnurlRows.slice(0, LNURL_CHECK_CAP)) {
    try {
      const verify = await checkLnurlVerify(inv.lnurlVerifyUrl!);
      if (verify.settled) {
        await settleInvoice(inv, new Date()).catch((err) =>
          logger.warn({ err, invoiceId: inv.id }, `${context}: lnurl settle error`),
        );
      }
    } catch (err) {
      logger.debug?.({ err, invoiceId: inv.id }, `${context}: lnurl verify check failed - treating as pending`);
    }
  }
  invoices = invoices.filter((inv) => !inv.lnurlVerifyUrl);

  const byWallet = new Map<string, PendingInvoiceRow[]>();
  for (const inv of invoices) {
    const nwcUrl = resolveNwcUrl(inv.nwcUrlEncrypted);
    if (!nwcUrl) continue; // no wallet URL stored - nothing to check against
    const group = byWallet.get(nwcUrl);
    if (group) group.push(inv);
    else byWallet.set(nwcUrl, [inv]);
  }

  for (const [nwcUrl, group] of byWallet) {
    if (relayInCooldown()) return;

    // Invoices still needing a check after the batch pass. A truncated
    // list_transactions page (busy wallet) must NOT leave paid invoices
    // unsettled, so unmatched invoices always get a targeted lookup.
    let remaining: PendingInvoiceRow[] = group;

    if (!walletsWithoutListTx.has(nwcUrl)) {
      try {
        const oldestSec = Math.floor(Math.min(...group.map((i) => i.createdAt.getTime())) / 1000) - 60;
        const txs = await listTransactions(nwcUrl, { from: oldestSec, limit: 100 });
        // Settled state, a settlement timestamp, or a revealed preimage each
        // prove payment - some wallets (e.g. Primal) omit settled_at.
        const settledByHash = new Map(
          txs
            .filter((tx) => tx.type === "incoming" && (tx.settledAt || tx.state === "settled" || tx.preimage))
            .map((tx) => [tx.paymentHash, tx.settledAt ?? tx.createdAt ?? new Date()]),
        );
        const unmatched: PendingInvoiceRow[] = [];
        for (const inv of group) {
          const settledAt = settledByHash.get(inv.paymentHash);
          if (settledAt) {
            await settleInvoice(inv, settledAt).catch((err) =>
              logger.warn({ err, invoiceId: inv.id }, `${context}: settle error`),
            );
          } else {
            unmatched.push(inv);
          }
        }
        // If the page was truncated, a paid tx may be beyond it - the
        // unmatched invoices below are verified individually. If the page
        // covered everything, the targeted lookups still cost at most one
        // request per genuinely-unpaid invoice.
        if (txs.length < 100) {
          // Full window returned - anything unmatched is genuinely unpaid.
          continue;
        }
        remaining = unmatched;
      } catch (err) {
        if (noteRelayOverload(err)) return;
        if (isUnsupportedMethodError(err)) {
          walletsWithoutListTx.add(nwcUrl);
          logger.info(`${context}: wallet does not support list_transactions - using per-invoice lookups`);
        } else {
          logger.warn({ err }, `${context}: list_transactions failed`);
          continue;
        }
      }
    }

    // Bounded per-invoice lookups: fallback for unsupported wallets, and
    // completeness pass for invoices unmatched on a truncated page.
    for (const inv of remaining) {
      if (relayInCooldown()) return;
      try {
        const status = await lookupInvoice(inv.paymentHash, nwcUrl);
        if (status.paid) {
          await settleInvoice(inv, status.paidAt ?? new Date());
        }
      } catch (err) {
        if (noteRelayOverload(err)) return;
        logger.warn({ err, invoiceId: inv.id }, `${context}: failed to check invoice`);
      }
    }
  }
}

export function reconcileAccountInvoices(accountId: string): Promise<void> {
  // If a sweep for this account is already running, join it so parallel
  // balance + transactions requests both see its result.
  const inflight = inflightReconciles.get(accountId);
  if (inflight) return inflight;

  const now = Date.now();
  const last = lastReconcileAt.get(accountId) ?? 0;
  if (now - last < RECONCILE_DEBOUNCE_MS) return Promise.resolve();
  lastReconcileAt.set(accountId, now);

  // Bound map growth
  if (lastReconcileAt.size > 1_000) {
    for (const [key, ts] of lastReconcileAt) {
      if (now - ts > RECONCILE_DEBOUNCE_MS) lastReconcileAt.delete(key);
    }
  }

  const run = doReconcile(accountId).finally(() => {
    inflightReconciles.delete(accountId);
  });
  inflightReconciles.set(accountId, run);
  return run;
}

async function doReconcile(accountId: string): Promise<void> {
  if (relayInCooldown()) return;

  const unpaid = await db
    .select()
    .from(pendingInvoicesTable)
    .where(
      and(
        eq(pendingInvoicesTable.accountId, accountId),
        isNull(pendingInvoicesTable.paidAt),
        gt(pendingInvoicesTable.expiresAt, new Date(Date.now() - EXPIRY_GRACE_MS)),
      ),
    )
    .orderBy(desc(pendingInvoicesTable.createdAt))
    .limit(RECONCILE_MAX_INVOICES);

  if (unpaid.length === 0) return;
  await checkInvoiceBatch(unpaid as PendingInvoiceRow[], "On-demand reconcile");
}

/**
 * Reconcile with a hard time bound so read endpoints never hang on Veil.
 * Resolves after RECONCILE_TIMEOUT_MS even if lookups are still in flight -
 * any late settlements still complete in the background.
 */
export function reconcileAccountInvoicesBounded(accountId: string): Promise<void> {
  const work = reconcileAccountInvoices(accountId).catch((err) =>
    logger.warn({ err, accountId }, "On-demand reconcile error"),
  );
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, RECONCILE_TIMEOUT_MS);
    timer.unref?.();
    work.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ── Per-invoice sub-wallet subscriptions ─────────────────────────────────────

const subWalletUnsubs = new Map<string, () => void>(); // paymentHash → cleanup fn
const MAX_INVOICE_SUBSCRIPTIONS = 50;
const SUBSCRIPTION_TTL_MS = 60 * 60 * 1000; // default invoice expiry (1h)

/**
 * Subscribe to payment_received notifications for a specific Veil invoice.
 * Call this immediately after creating a pending invoice.
 * Each subscription auto-cleans at the TTL (invoice expiry) and the total
 * number of concurrent subscriptions is capped - the on-demand reconcile and
 * fallback cron cover anything skipped.
 */
export async function subscribeSubWalletInvoice(
  paymentHash: string,
  nwcUrl: string,
  ttlMs = SUBSCRIPTION_TTL_MS,
): Promise<void> {
  if (subWalletUnsubs.has(paymentHash)) return;
  if (subWalletUnsubs.size >= MAX_INVOICE_SUBSCRIPTIONS) {
    logger.warn({ paymentHash, active: subWalletUnsubs.size }, "Invoice subscription budget reached - relying on reconcile/cron");
    return;
  }
  if (relayInCooldown()) return;

  try {
    const client = new NWCClient({ nostrWalletConnectUrl: nwcUrl });
    const unsubNotif = await client.subscribeNotifications(
      async (notif) => {
        if (
          notif.notification_type === "payment_received" &&
          notif.notification.payment_hash === paymentHash
        ) {
          const tx = notif.notification;
          const paidAt = tx.settled_at ? new Date(tx.settled_at * 1000) : new Date();
          await settleInvoiceByPaymentHash(paymentHash, paidAt).catch((err) =>
            logger.warn({ err, paymentHash }, "Invoice settlement error"),
          );
          cleanup();
        }
      },
      ["payment_received"],
    );

    // Auto-unsubscribe once the invoice can no longer be paid
    const expiryTimer = setTimeout(() => cleanup(), ttlMs + 60_000);
    expiryTimer.unref?.();

    const cleanup = () => {
      clearTimeout(expiryTimer);
      try { unsubNotif(); } catch { /* ignore */ }
      try { client.close(); } catch { /* ignore */ }
      subWalletUnsubs.delete(paymentHash);
    };

    subWalletUnsubs.set(paymentHash, cleanup);
    logger.info({ paymentHash, active: subWalletUnsubs.size }, "Veil invoice subscription active");
  } catch (err) {
    if (!noteRelayOverload(err)) {
      logger.warn({ err, paymentHash }, "Veil invoice subscription failed - cron will cover it");
    }
  }
}

// ── Fallback cron (every minute) ─────────────────────────────────────────────
// Catches any invoices whose push notification was missed due to relay hiccups.

// Progressing composite cursor (createdAt, id) so every unpaid invoice within
// the grace window is eventually visited regardless of backlog size. The id
// tie-break makes pagination stable when invoices share a createdAt timestamp.
// Each run picks the next SWEEP_MAX_INVOICES oldest-first after the cursor;
// when the window is exhausted the cursor wraps to the start.
let sweepCursor: { createdAt: Date; id: string } | null = null;

async function runFallbackSweep(): Promise<void> {
  if (relayInCooldown()) return;

  const graceCutoff = new Date(Date.now() - EXPIRY_GRACE_MS);
  const baseWhere = and(
    isNull(pendingInvoicesTable.paidAt),
    gt(pendingInvoicesTable.expiresAt, graceCutoff),
  );

  const afterCursor = sweepCursor
    ? or(
        gt(pendingInvoicesTable.createdAt, sweepCursor.createdAt),
        and(
          eq(pendingInvoicesTable.createdAt, sweepCursor.createdAt),
          gt(pendingInvoicesTable.id, sweepCursor.id),
        ),
      )
    : undefined;

  let unpaid = await db
    .select()
    .from(pendingInvoicesTable)
    .where(afterCursor ? and(baseWhere, afterCursor) : baseWhere)
    .orderBy(asc(pendingInvoicesTable.createdAt), asc(pendingInvoicesTable.id))
    .limit(SWEEP_MAX_INVOICES);

  // Window exhausted - wrap to the start
  if (unpaid.length < SWEEP_MAX_INVOICES) {
    sweepCursor = null;
    if (unpaid.length === 0) {
      unpaid = await db
        .select()
        .from(pendingInvoicesTable)
        .where(baseWhere)
        .orderBy(asc(pendingInvoicesTable.createdAt), asc(pendingInvoicesTable.id))
        .limit(SWEEP_MAX_INVOICES);
    }
  }

  if (unpaid.length === 0) return;
  if (unpaid.length === SWEEP_MAX_INVOICES) {
    const last = unpaid[unpaid.length - 1];
    sweepCursor = { createdAt: last.createdAt, id: last.id };
  }
  await checkInvoiceBatch(unpaid as PendingInvoiceRow[], "Fallback sweep");
}

// ── Pending-send reconciliation ──────────────────────────────────────────────
// Outgoing payments whose relay reply timed out are left status='pending'
// (never falsely 'failed' - that caused a real triple-charge on a Bolt Card).
// This sweep asks the paying wallet for the true outcome and finalizes the
// row. It also clears the per-card in-flight tap guard.

const SEND_RECONCILE_MIN_AGE_MS = 8 * 1000; // short grace; checkOwnSettlementProof is now live-hold-aware
const SEND_RECONCILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// NOT_FOUND from the wallet right after send can race its own record - only
// trust it as "never initiated" once the payment is comfortably old.
const SEND_NOT_FOUND_FAIL_AGE_MS = 3 * 60 * 1000;
const SEND_RECONCILE_BATCH = 10;

export async function reconcilePendingSends(): Promise<void> {
  if (relayInCooldown()) return;

  const now = Date.now();
  const rows = await db
    .select({
      id: transactionsTable.id,
      accountId: transactionsTable.accountId,
      bolt11: transactionsTable.bolt11,
      paymentHash: transactionsTable.paymentHash,
      createdAt: transactionsTable.createdAt,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.direction, "out"),
        eq(transactionsTable.status, "pending"),
        eq(transactionsTable.type, "send"),
        isNotNull(transactionsTable.bolt11),
        lt(transactionsTable.createdAt, new Date(now - SEND_RECONCILE_MIN_AGE_MS)),
        gt(transactionsTable.createdAt, new Date(now - SEND_RECONCILE_MAX_AGE_MS)),
      ),
    )
    .orderBy(asc(transactionsTable.createdAt))
    .limit(SEND_RECONCILE_BATCH);

  for (const tx of rows) {
    // Resolve the payment hash: prefer the stored column, fall back to
    // decoding the bolt11 (rows created before the column was populated).
    let txHash: string | null = tx.paymentHash;
    if (!txHash && tx.bolt11) {
      try { txHash = extractPaymentHash(tx.bolt11); } catch { /* ignore */ }
    }

    // In-network fast path: our own settled invoice record for this hash is
    // authoritative proof of success - no relay round-trip needed.
    try {
      const proven = await checkOwnSettlementProof(txHash);
      if (proven) {
        const finalized = await finalizePendingSend(tx.id, { status: "completed", paymentHash: proven });
        if (finalized) logger.info({ txId: tx.id, paymentHash: proven }, "Pending send reconciled: settled (own invoice record)");
        continue;
      }
    } catch (dbErr) {
      logger.warn({ dbErr, txId: tx.id }, "Own-settlement proof check failed");
    }

    if (relayInCooldown()) return;
    const nwcUrl = await getAccountNwcUrl(tx.accountId).catch(() => undefined);
    if (!nwcUrl) continue;
    try {
      const inv = await lookupOutgoingPayment(tx.bolt11!, nwcUrl);
      if (inv.paid) {
        const finalized = await finalizePendingSend(tx.id, {
          status: "completed",
          paymentHash: inv.paymentHash,
          feeSats: Math.ceil((inv.feesPaidMsats ?? 0) / 1000),
        });
        if (finalized) {
          logger.info({ txId: tx.id, paymentHash: inv.paymentHash }, "Pending send reconciled: settled");
          if (inv.paymentHash) {
            // In-network payment: settle the merchant's pending invoice too
            await settleInvoiceByPaymentHash(inv.paymentHash, inv.paidAt ?? new Date()).catch((err) =>
              logger.warn({ err, txId: tx.id }, "Reconcile fast-path settle failed - invoice sweep will cover"),
            );
          }
        }
      } else if (inv.state === "failed") {
        await finalizePendingSend(tx.id, { status: "failed", reason: "Wallet reported payment failed" });
        logger.info({ txId: tx.id }, "Pending send reconciled: failed");
      }
      // pending / unknown state - leave for the next sweep
    } catch (err) {
      if (noteRelayOverload(err)) return;
      if (isPaymentNotFoundError(err) && tx.createdAt.getTime() < now - SEND_NOT_FOUND_FAIL_AGE_MS) {
        // NOT_FOUND after the grace window. A false "failed" on real money is
        // the worst outcome, so corroborate against the wallet's transaction
        // list before trusting it: the payment must be absent there too.
        const verdict = await corroborateNotFound(tx.id, txHash, tx.createdAt, nwcUrl);
        if (verdict === "failed") {
          await finalizePendingSend(tx.id, { status: "failed", reason: "Wallet has no record of this payment" });
          logger.warn({ txId: tx.id }, "Pending send reconciled: no record in lookup or transaction list - marked failed");
        }
        // "settled" is finalized inside corroborateNotFound; "unknown" leaves
        // the row pending for the next sweep.
      } else {
        logger.warn({ err, txId: tx.id }, "Pending send reconcile check failed");
      }
    }
  }
}

/**
 * Second opinion before failing a pending send on lookup NOT_FOUND.
 * Cross-checks the wallet's own transaction list for the payment hash:
 * - present + settled → finalize completed, return "settled"
 * - present + failed → return "failed"
 * - absent on a complete page → return "failed" (corroborated)
 * - list unavailable / hash unknown / truncated page without a match →
 *   return "unknown" (leave pending - never fail on a single source)
 */
async function corroborateNotFound(
  txId: string,
  txHash: string | null,
  createdAt: Date,
  nwcUrl: string,
): Promise<"settled" | "failed" | "unknown"> {
  if (!txHash) return "unknown"; // cannot corroborate without a hash - never fail blind
  try {
    const fromSec = Math.floor(createdAt.getTime() / 1000) - 300;
    const txs = await listTransactions(nwcUrl, { from: fromSec, limit: 100 });
    const match = txs.find((t) => t.type === "outgoing" && t.paymentHash === txHash);
    if (match) {
      if (match.settledAt || match.state === "settled" || match.preimage) {
        const finalized = await finalizePendingSend(txId, {
          status: "completed",
          paymentHash: txHash,
          feeSats: Math.ceil((match.feesMsats ?? 0) / 1000),
        });
        if (finalized) {
          logger.info({ txId, paymentHash: txHash }, "Pending send reconciled: settled (transaction list)");
          await settleInvoiceByPaymentHash(txHash, match.settledAt ?? new Date()).catch(() => {});
        }
        return "settled";
      }
      if (match.state === "failed") return "failed";
      return "unknown"; // present but still pending on the wallet side
    }
    // Absent from the list. Only corroborate "never happened" when the page
    // was complete - a truncated page may simply not reach this payment.
    return txs.length < 100 ? "failed" : "unknown";
  } catch (err) {
    noteRelayOverload(err);
    logger.warn({ err, txId }, "NOT_FOUND corroboration via list_transactions failed - leaving pending");
    return "unknown";
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function startInvoiceMonitor(): void {
  // Per-invoice Veil subscriptions handle instant settlement.
  // Cron is the safety net for missed push notifications.
  // Fast path: pending-send + open-wrap recovery every 20s (money UX).
  // Heavy fallback sweep stays at 2 min.
  cron.schedule("*/20 * * * * *", async () => {
    try {
      await reconcilePendingSends();
    } catch (err) {
      logger.error({ err }, "Pending send reconcile error");
    }
  });
  cron.schedule("*/2 * * * *", async () => {
    try {
      await runFallbackSweep();
    } catch (err) {
      logger.error({ err }, "Invoice fallback sweep error");
    }
    try {
      await reconcilePendingSends();
    } catch (err) {
      logger.error({ err }, "Pending send reconcile error");
    }
  });

  // Startup sweep - catch any invoices paid while the server was down
  runFallbackSweep().catch((err) => logger.warn({ err }, "Startup invoice sweep error"));
  reconcilePendingSends().catch((err) => logger.warn({ err }, "Startup send reconcile error"));

  logger.info("Invoice monitor started");
}
