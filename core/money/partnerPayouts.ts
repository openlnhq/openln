import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db, partnerAccountsTable, partnerAuditEventsTable, partnerEarningsTable, partnerPayoutsTable } from "../db/index.js";
import type { PartnerPayout } from "../db/schema/partner.js";
import { fetchLnurlpMetadata, requestLnurlInvoice } from "./lnAddress.js";
import { getBalance, isAmbiguousPayError, lookupOutgoingPayment, payInvoice, PLATFORM_NWC_URL } from "./nwc.js";
import { logger } from "./logger.js";

/** A payout can only be requested once this much has accrued. */
export const MIN_PAYOUT_SATS = 1000;
const PAYOUT_MEMO = "openLN partner payout";
/** A 'sending' payout with no invoice and no update for this long is safe to requeue. */
const REQUEUE_NO_INVOICE_MS = 5 * 60 * 1000;

export interface PartnerBalance {
  earnedSats: number;
  paidSats: number;
  pendingSats: number;
  availableSats: number;
}

type PayoutExec = Pick<typeof db, "select">;

async function balanceWith(exec: PayoutExec, partnerId: string): Promise<PartnerBalance> {
  const [earned] = await exec
    .select({ v: sql<number>`coalesce(sum(${partnerEarningsTable.feeShareSats}),0)::int` })
    .from(partnerEarningsTable)
    .where(eq(partnerEarningsTable.partnerId, partnerId));
  const [payoutSums] = await exec
    .select({
      paid: sql<number>`coalesce(sum(${partnerPayoutsTable.amountSats}) filter (where ${partnerPayoutsTable.state} = 'sent'),0)::int`,
      pending: sql<number>`coalesce(sum(${partnerPayoutsTable.amountSats}) filter (where ${partnerPayoutsTable.state} in ('requested','sending')),0)::int`,
    })
    .from(partnerPayoutsTable)
    .where(eq(partnerPayoutsTable.partnerId, partnerId));
  const earnedSats = Number(earned?.v ?? 0);
  const paidSats = Number(payoutSums?.paid ?? 0);
  const pendingSats = Number(payoutSums?.pending ?? 0);
  return { earnedSats, paidSats, pendingSats, availableSats: Math.max(0, earnedSats - paidSats - pendingSats) };
}

/** Earned minus sent minus in-flight (requested/sending). */
export function partnerBalance(partnerId: string): Promise<PartnerBalance> {
  return balanceWith(db, partnerId);
}

async function audit(partnerId: string | null, event: string, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    await db.insert(partnerAuditEventsTable).values({ partnerId, event, detail });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), event }, "partner audit insert failed");
  }
}

/** Payouts this partner can see, newest first. */
export function listPartnerPayouts(partnerId: string, limit = 50): Promise<PartnerPayout[]> {
  return db
    .select()
    .from(partnerPayoutsTable)
    .where(eq(partnerPayoutsTable.partnerId, partnerId))
    .orderBy(desc(partnerPayoutsTable.createdAt))
    .limit(limit);
}

/** Recent earnings rows for the partner ledger view, newest first. */
export function listPartnerEarnings(partnerId: string, limit = 200) {
  return db
    .select()
    .from(partnerEarningsTable)
    .where(eq(partnerEarningsTable.partnerId, partnerId))
    .orderBy(desc(partnerEarningsTable.createdAt))
    .limit(limit);
}

export type SetAddressResult = { ok: true; address: string } | { ok: false; status: number; error: string };

/**
 * Validate and store the partner's payout destination. The address must
 * resolve as an LNURL-pay endpoint that can receive at least the minimum
 * payout per payment, so a payout can never be stranded on a bad address.
 */
export async function setPayoutAddress(partnerId: string, addressRaw: string): Promise<SetAddressResult> {
  const address = addressRaw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return { ok: false, status: 400, error: "Enter a Lightning Address like name@wallet.com" };
  }
  try {
    const meta = await fetchLnurlpMetadata(address);
    if (Number(meta.maxSendableMsats) < MIN_PAYOUT_SATS * 1000) {
      return { ok: false, status: 400, error: `This address cannot receive ${MIN_PAYOUT_SATS} sats or more per payment` };
    }
  } catch {
    return { ok: false, status: 400, error: "Could not reach this Lightning Address. Check it and try again." };
  }
  await db.update(partnerAccountsTable).set({ lightningAddress: address }).where(eq(partnerAccountsTable.id, partnerId));
  await audit(partnerId, "payout_address.set", { address });
  return { ok: true, address };
}

export type PayoutRequestResult = { ok: true; payout: PartnerPayout } | { ok: false; status: number; error: string };

/**
 * Create a payout for the full available balance. Serialized per partner
 * (row lock) and blocked while any payout is already in flight, so requests
 * racing each other cannot double-book the balance.
 */
export async function requestPartnerPayout(partnerId: string, deps: PartnerPayoutDeps = realDeps): Promise<PayoutRequestResult> {
  const [partner] = await db.select().from(partnerAccountsTable).where(eq(partnerAccountsTable.id, partnerId)).limit(1);
  if (!partner) return { ok: false, status: 404, error: "Partner not found" };
  if (!partner.lightningAddress) return { ok: false, status: 400, error: "Set your payout address first" };
  const result = await db.transaction(async (tx) => {
    await tx.select({ id: partnerAccountsTable.id }).from(partnerAccountsTable).where(eq(partnerAccountsTable.id, partnerId)).for("update");
    const [pending] = await tx
      .select({ id: partnerPayoutsTable.id })
      .from(partnerPayoutsTable)
      .where(and(eq(partnerPayoutsTable.partnerId, partnerId), inArray(partnerPayoutsTable.state, ["requested", "sending"])))
      .limit(1);
    if (pending) return { ok: false as const, status: 409, error: "A payout is already pending" };
    const bal = await balanceWith(tx as unknown as PayoutExec, partnerId);
    if (bal.availableSats < MIN_PAYOUT_SATS) {
      return { ok: false as const, status: 400, error: `Balance below the ${MIN_PAYOUT_SATS} sat minimum payout` };
    }
    const [row] = await tx
      .insert(partnerPayoutsTable)
      .values({ partnerId, amountSats: bal.availableSats, state: "requested", destination: partner.lightningAddress ?? null })
      .returning();
    return { ok: true as const, payout: row };
  });
  if (result.ok) {
    await audit(partnerId, "payout.requested", { payoutId: result.payout.id, amountSats: result.payout.amountSats, destination: result.payout.destination });
    void executePayout(result.payout.id, deps).catch((err) =>
      logger.error({ err: err instanceof Error ? err.message : String(err), payoutId: result.payout.id }, "partner payout kick failed"),
    );
  }
  return result;
}

/** Injectable money-movement deps (tests substitute fakes; prod uses the real ones). */
export interface PartnerPayoutDeps {
  requestInvoice: (address: string, amountSats: number, memo?: string) => Promise<{ bolt11: string; paymentHash: string }>;
  pay: (bolt11: string, nwcUrl?: string) => Promise<{ preimage: string; paymentHash: string }>;
  balance: (nwcUrl?: string) => Promise<{ balanceSats: number }>;
  lookup: (bolt11: string, nwcUrl?: string) => Promise<{ state?: string; preimage?: string } | undefined>;
}

const realDeps: PartnerPayoutDeps = { requestInvoice: requestLnurlInvoice, pay: payInvoice, balance: getBalance, lookup: lookupOutgoingPayment };

/**
 * Execute one requested payout: claim it, mint an invoice to the partner's
 * address from the platform wallet, pay it, then record the outcome. Only a
 * conditional UPDATE can claim a payout (requested -> sending), so concurrent
 * callers cannot double-send.
 */
export async function executePayout(payoutId: string, deps: PartnerPayoutDeps = realDeps): Promise<string> {
  const [claimed] = await db
    .update(partnerPayoutsTable)
    .set({ state: "sending", updatedAt: new Date(), error: null })
    .where(and(eq(partnerPayoutsTable.id, payoutId), eq(partnerPayoutsTable.state, "requested")))
    .returning();
  if (!claimed) return "skipped";
  await audit(claimed.partnerId, "payout.sending", { payoutId, amountSats: claimed.amountSats });
  try {
    const [partner] = await db.select().from(partnerAccountsTable).where(eq(partnerAccountsTable.id, claimed.partnerId)).limit(1);
    if (!partner) throw new Error("Partner not found");
    const address = claimed.destination ?? partner.lightningAddress;
    if (!address) throw new Error("No payout address set");
    // Send-time re-check: this payout plus every other in-flight item must be
    // covered by earnings that are still on the books.
    const bal = await partnerBalance(claimed.partnerId);
    const othersPending = bal.pendingSats - claimed.amountSats;
    if (claimed.amountSats > bal.earnedSats - bal.paidSats - othersPending) throw new Error("Insufficient accrued balance");
    if (!PLATFORM_NWC_URL) throw new Error("Platform wallet not configured");
    const float = await deps.balance(PLATFORM_NWC_URL);
    if (float.balanceSats < claimed.amountSats) throw new Error("Platform float insufficient, try again later");
    const invoice = await deps.requestInvoice(address, claimed.amountSats, PAYOUT_MEMO);
    await db
      .update(partnerPayoutsTable)
      .set({ bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, updatedAt: new Date() })
      .where(eq(partnerPayoutsTable.id, payoutId));
    const sent = await deps.pay(invoice.bolt11, PLATFORM_NWC_URL);
    await db
      .update(partnerPayoutsTable)
      .set({ state: "sent", paymentHash: sent.paymentHash || invoice.paymentHash, preimage: sent.preimage || null, error: null, updatedAt: new Date() })
      .where(eq(partnerPayoutsTable.id, payoutId));
    await audit(claimed.partnerId, "payout.sent", { payoutId, amountSats: claimed.amountSats, paymentHash: sent.paymentHash || invoice.paymentHash, destination: address });
    logger.info({ payoutId, partnerId: claimed.partnerId, amountSats: claimed.amountSats }, "partner payout sent");
    return "sent";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAmbiguousPayError(err)) {
      await audit(claimed.partnerId, "payout.ambiguous", { payoutId, message });
      logger.warn({ payoutId, message }, "partner payout outcome unknown - reconciling");
      return await reconcilePayout(payoutId, deps).catch(() => "sending");
    }
    await db.update(partnerPayoutsTable).set({ state: "failed", error: message, updatedAt: new Date() }).where(eq(partnerPayoutsTable.id, payoutId));
    await audit(claimed.partnerId, "payout.failed", { payoutId, message });
    logger.error({ payoutId, message }, "partner payout failed");
    return "failed";
  }
}

/**
 * Resolve a payout stuck in 'sending' by asking the wallet. Only a definitive
 * answer finalizes it; an unresolved lookup leaves the payout in 'sending'
 * (balance stays reserved) and is retried by the driver. Never auto-fails a
 * possibly-sent payment, which would risk a double payout on the retry.
 */
export async function reconcilePayout(payoutId: string, deps: PartnerPayoutDeps = realDeps): Promise<string> {
  const [row] = await db.select().from(partnerPayoutsTable).where(eq(partnerPayoutsTable.id, payoutId)).limit(1);
  if (!row) return "missing";
  if (row.state !== "sending") return row.state;
  if (!row.bolt11) {
    if (Date.now() - row.updatedAt.getTime() > REQUEUE_NO_INVOICE_MS) {
      await db
        .update(partnerPayoutsTable)
        .set({ state: "requested", updatedAt: new Date(), error: "Requeued after an interrupted attempt" })
        .where(eq(partnerPayoutsTable.id, payoutId));
      return "requested";
    }
    return "sending";
  }
  if (!PLATFORM_NWC_URL) return "sending";
  const look = await deps.lookup(row.bolt11, PLATFORM_NWC_URL).catch(() => undefined);
  if (look && (look.state === "settled" || (!!look.preimage && look.state !== "failed"))) {
    await db
      .update(partnerPayoutsTable)
      .set({ state: "sent", preimage: look.preimage || row.preimage, error: null, updatedAt: new Date() })
      .where(eq(partnerPayoutsTable.id, payoutId));
    await audit(row.partnerId, "payout.reconciled_sent", { payoutId });
    return "sent";
  }
  if (look && look.state === "failed") {
    await db
      .update(partnerPayoutsTable)
      .set({ state: "failed", error: row.error || "Wallet reported the payment failed", updatedAt: new Date() })
      .where(eq(partnerPayoutsTable.id, payoutId));
    await audit(row.partnerId, "payout.reconciled_failed", { payoutId });
    return "failed";
  }
  // Still unknown: bump updatedAt so the next sweep waits a full interval.
  await db.update(partnerPayoutsTable).set({ updatedAt: new Date() }).where(eq(partnerPayoutsTable.id, payoutId));
  return "sending";
}

let payoutDriverTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Background safety net: executes requested payouts whose immediate kick was
 * lost (crash/restart) and re-reconciles stuck sends. Request-time kicks are
 * still the fast path.
 */
export function startPartnerPayoutDriver(intervalMs = 60_000): () => void {
  const tick = async () => {
    try {
      const staleMs = 10_000;
      const requested = await db
        .select({ id: partnerPayoutsTable.id })
        .from(partnerPayoutsTable)
        .where(and(eq(partnerPayoutsTable.state, "requested"), lt(partnerPayoutsTable.updatedAt, new Date(Date.now() - staleMs))))
        .limit(5);
      for (const r of requested) await executePayout(r.id);
      const sending = await db
        .select({ id: partnerPayoutsTable.id })
        .from(partnerPayoutsTable)
        .where(and(eq(partnerPayoutsTable.state, "sending"), lt(partnerPayoutsTable.updatedAt, new Date(Date.now() - 2 * 60_000))))
        .limit(5);
      for (const s of sending) await reconcilePayout(s.id);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "partner payout driver tick failed");
    }
  };
  if (payoutDriverTimer) clearInterval(payoutDriverTimer);
  payoutDriverTimer = setInterval(() => { void tick(); }, intervalMs);
  payoutDriverTimer.unref?.();
  void tick();
  return () => { if (payoutDriverTimer) { clearInterval(payoutDriverTimer); payoutDriverTimer = undefined; } };
}
