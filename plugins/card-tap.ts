/** Port of bitPOS routes/lnurlw.ts. Adaptations: HTTP router, imports, native/legacy PIN verifier and public brand. Core money modules unchanged. */
/**
 * LNURLw (LNURL-withdraw) routes for Bolt Card tap-to-pay.
 *
 * Flow:
 *  1. Card tapped at NFC reader/wallet  → GET /card/:cardId?p=<hex>&c=<hex>
 *     - Server decrypts stored AES keys, verifies AES SUN params
 *     - Atomically advances counter (row-level lock), issues k1 challenge
 *     - Returns LNURLw JSON with callback URL
 *
 *  2. Wallet fetches lightning invoice from merchant POS, calls:
 *     GET /card/:cardId/callback?k1=<challenge>&pr=<bolt11>
 *     - k1 consumed ATOMICALLY (conditional UPDATE) - prevents double-spend race
 *     - Validates amount limits and balance, then executes payment
 *
 * These routes live at root level (no /api prefix) because NFC wallets call
 * the URL embedded in the card's NDEF record directly.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyCardPin } from "../core/auth/card-pin.js";
import { db } from "../core/db/index.js";
import { cardsTable, transactionsTable } from "../core/db/index.js";
import { eq, and, gte, isNull, isNotNull, sql } from "drizzle-orm";
import { decryptSunP, verifySunC, parseBolt11AmountSats, generateK1 } from "../core/money/boltcard.js";
import { processExternalPayment, AmbiguousPaymentError, resolveAmbiguousPayment } from "../core/money/feeEngine.js";
import { getAccountNwcUrl } from "../core/money/nwc.js";
import { settleInvoiceByPaymentHash } from "../core/money/invoiceMonitor.js";
import { decrypt } from "../core/money/encrypt.js";
import { logger } from "../core/money/logger.js";
import { DOMAIN } from "../core/domain.js";

type Request = { params: Record<string,string>; query: Record<string,string> };
type Response = { json: (value: unknown) => void };
const K1_TTL_MS = 5 * 60 * 1000; // k1 challenge expires after 5 minutes

function resolveKey(encrypted: string): string {
  return decrypt(encrypted);
}

// ── Tap endpoint: GET /card/:cardId?p=<hex>&c=<hex> ─────────────────────────
async function tap(req: Request, res: Response): Promise<void> {
  const cardId = Array.isArray(req.params.cardId) ? req.params.cardId[0] : req.params.cardId;
  const pHex = String(req.query.p ?? "").toLowerCase();
  const cHex = String(req.query.c ?? "").toLowerCase();

  const [card] = await db
    .select()
    .from(cardsTable)
    .where(eq(cardsTable.id, cardId));

  if (!card) {
    res.json({ status: "ERROR", reason: "Card not found" });
    return;
  }

  if (card.status === "cancelled") {
    res.json({ status: "ERROR", reason: "Card has been cancelled" });
    return;
  }

  // ── LUD-21: Block tap if card PIN is locked ───────────────────────────────
  if (card.pinLockedAt) {
    res.json({ status: "ERROR", reason: "Card PIN is locked after too many failed attempts. Unlock it in the app." });
    return;
  }

  // NOTE: frozen cards are NOT rejected at tap time - the freeze check happens
  // at the callback stage so wallets (e.g. WoS) see the error at payment time
  // rather than hanging on an unhandled ERROR response from the tap endpoint.

  // ── Provisioning verification test ────────────────────────────────────────
  // The Bolt Card NFC Creator app verifies the lnurlw endpoint is reachable
  // after programming by sending all-zero p and c values. We must respond with
  // a valid withdrawRequest - AES-SUN cannot be verified with zero inputs.
  const isProvisioningTest =
    /^0+$/.test(pHex) && /^0+$/.test(cHex) && pHex.length > 0 && cHex.length > 0;

  if (isProvisioningTest) {
    logger.info({ cardId }, "Bolt Card provisioning verification test received");
    const provTestResp: Record<string, unknown> = {
      tag: "withdrawRequest",
      callback: `https://${DOMAIN}/card/${cardId}/callback`,
      k1: "0000000000000000000000000000000000000000000000000000000000000000",
      defaultDescription: card.note ?? "openLN card payment",
      minWithdrawable: 1000,
      maxWithdrawable: card.perTapLimitSats * 1000,
    };
    // LUD-21: always include pinLimit when PIN is enabled; null threshold → 0 (always required)
    if (card.pinHash != null) provTestResp.pinLimit = card.pinLimitMsats ?? 0;
    res.json(provTestResp);
    return;
  }

  // Balance is NOT checked here - Veil is the source of truth and the live
  // balance check happens at the callback stage. Keeping the tap fast and
  // reliable matters more than an early balance error.
  if (!pHex || !cHex) {
    res.json({ status: "ERROR", reason: "Missing p or c parameter" });
    return;
  }

  // ── AES SUN verification - decrypt stored keys first ─────────────────────
  let key1Hex: string;
  let key2Hex: string;
  try {
    key1Hex = resolveKey(card.aesKey1);
    key2Hex = resolveKey(card.aesKey2);
  } catch {
    logger.error({ cardId }, "Failed to decrypt card AES keys");
    res.json({ status: "ERROR", reason: "Internal error" });
    return;
  }

  const sunData = decryptSunP(key1Hex, pHex);
  if (!sunData) {
    logger.warn({ cardId }, "Bolt Card p-parameter decryption failed - card keys likely out of sync with DB");
    res.json({ status: "ERROR", reason: "Card authentication failed. If you recently wiped this card, please re-provision it." });
    return;
  }

  if (!verifySunC(key2Hex, sunData.uid, sunData.counter, cHex)) {
    logger.warn({ cardId }, "Bolt Card CMAC verification failed");
    res.json({ status: "ERROR", reason: "Card authentication failed (CMAC mismatch). Please re-provision the card." });
    return;
  }

  // ── Counter replay protection ─────────────────────────────────────────────
  // Row-level lock ensures only one concurrent tap can advance the counter.
  const k1 = generateK1();
  const k1ExpiresAt = new Date(Date.now() + K1_TTL_MS);

  const advanced = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ counter: cardsTable.counter })
      .from(cardsTable)
      .where(eq(cardsTable.id, cardId))
      .for("update");

    if (!current) return false;
    if (sunData.counter <= current.counter) return false;

    await tx
      .update(cardsTable)
      .set({
        counter: sunData.counter,
        lastUsedAt: new Date(),
        pendingK1: k1,
        pendingK1ExpiresAt: k1ExpiresAt,
        // Bind UID to this physical chip on first tap; never overwrite once set
        ...(card.uid == null ? { uid: sunData.uid.toString("hex") } : {}),
      })
      .where(eq(cardsTable.id, cardId));

    return true;
  });

  if (!advanced) {
    logger.warn({ cardId, counter: sunData.counter }, "Counter replay rejected");
    res.json({ status: "ERROR", reason: "Counter replay detected" });
    return;
  }

  // ── Daily limit check ─────────────────────────────────────────────────────
  // Only count completed transactions - failed/pending don't represent real spend
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  const [spentRow] = await db
    .select({ totalSats: sql<number>`coalesce(sum(${transactionsTable.amountSats}), 0)` })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.cardId, cardId),
        eq(transactionsTable.direction, "out"),
        eq(transactionsTable.status, "completed"),
        gte(transactionsTable.createdAt, todayUtc),
      ),
    );

  const spentToday = Number(spentRow?.totalSats ?? 0);
  const remainingDailySats = card.dailyLimitSats - spentToday;

  if (remainingDailySats <= 0) {
    res.json({ status: "ERROR", reason: "Daily spending limit reached" });
    return;
  }

  // maxWithdrawable is capped by the card's spending limits only - the account
  // balance is intentionally excluded so it is never exposed to the reading wallet.
  // All real enforcement (balance, per-tap, daily) happens at the callback stage.
  const maxWithdrawableSats = Math.min(card.perTapLimitSats, remainingDailySats);

  // ── Return LNURLw response ────────────────────────────────────────────────
  const tapResp: Record<string, unknown> = {
    tag: "withdrawRequest",
    callback: `https://${DOMAIN}/card/${cardId}/callback`,
    k1,
    defaultDescription: card.note ?? "openLN card payment",
    minWithdrawable: 1000,
    maxWithdrawable: maxWithdrawableSats * 1000,
  };
  // LUD-21: always include pinLimit when PIN is enabled so POS wallets know to prompt.
  // pinLimitMsats=null means "always required", represented as 0 on the wire.
  if (card.pinHash != null) tapResp.pinLimit = card.pinLimitMsats ?? 0;
  res.json(tapResp);
}

// ── Callback: GET /card/:cardId/callback?k1=<challenge>&pr=<bolt11> ──────────
async function callback(req: Request, res: Response): Promise<void> {
  // Anchor the response deadline to request arrival. The POS device aborts its
  // HTTP request with error -11 after a short timeout, so every relay-bound
  // step (balance read, payment) must fit inside CARD_TAP_GLOBAL_DEADLINE_MS
  // measured from here - not from when the payment step happens to start.
  const requestStart = Date.now();
  const cardId = Array.isArray(req.params.cardId) ? req.params.cardId[0] : req.params.cardId;
  const k1 = String(req.query.k1 ?? "");
  const pr = String(req.query.pr ?? "");
  const pinParam = req.query.pin ? String(req.query.pin) : undefined;

  if (!k1 || !pr) {
    res.json({ status: "ERROR", reason: "Missing k1 or pr parameter" });
    return;
  }

  // ── Pre-check frozen status (non-atomic, safe - k1 consumption below is still atomic) ──
  const [cardRow] = await db
    .select({ status: cardsTable.status, name: cardsTable.name, note: cardsTable.note })
    .from(cardsTable)
    .where(eq(cardsTable.id, cardId));

  if (cardRow?.status === "frozen") {
    res.json({ status: "ERROR", reason: "Card is frozen - unfreeze it in the openLN app to pay" });
    return;
  }

  // ── Atomic k1 consumption ─────────────────────────────────────────────────
  // Single conditional UPDATE: only succeeds if k1 matches and hasn't expired.
  // This prevents any two concurrent callbacks from both passing validation -
  // only one will see a non-null return, the other gets null → rejected.
  const now = new Date();
  const [consumed] = await db
    .update(cardsTable)
    .set({ pendingK1: null, pendingK1ExpiresAt: null })
    .where(
      and(
        eq(cardsTable.id, cardId),
        eq(cardsTable.status, "active"),
        eq(cardsTable.pendingK1, k1),
        isNotNull(cardsTable.pendingK1ExpiresAt),
        gte(cardsTable.pendingK1ExpiresAt, now),
        // LUD-21: reject callback if card PIN is locked (defence-in-depth; tap endpoint also blocks)
        isNull(cardsTable.pinLockedAt),
      ),
    )
    .returning({
      accountId: cardsTable.accountId,
      perTapLimitSats: cardsTable.perTapLimitSats,
      dailyLimitSats: cardsTable.dailyLimitSats,
      pinHash: cardsTable.pinHash,
      pinLimitMsats: cardsTable.pinLimitMsats,
      pinFailCount: cardsTable.pinFailCount,
    });

  if (!consumed) {
    res.json({ status: "ERROR", reason: "Invalid or expired k1" });
    return;
  }

  const { accountId: cardAccountId, perTapLimitSats, dailyLimitSats, pinHash, pinLimitMsats, pinFailCount } = consumed;
  const cardShortId = cardId.replace(/-/g, "").slice(-8).replace(/(.{4})(.{4})/, "$1 $2");
  const cardLabel = cardRow?.name ?? cardShortId;

  // ── Decode bolt11 amount ──────────────────────────────────────────────────
  const amountSats = parseBolt11AmountSats(pr);
  if (amountSats === null || amountSats <= 0) {
    res.json({ status: "ERROR", reason: "Invalid or zero-amount invoice" });
    return;
  }

  // ── Per-tap limit check ───────────────────────────────────────────────────
  if (amountSats > perTapLimitSats) {
    res.json({
      status: "ERROR",
      reason: `Amount ${amountSats} sats exceeds per-tap limit of ${perTapLimitSats} sats`,
    });
    return;
  }

  // ── Daily limit check ─────────────────────────────────────────────────────
  // Only count completed transactions - pending/failed do not count as real spend
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  const [spentRow] = await db
    .select({ totalSats: sql<number>`coalesce(sum(${transactionsTable.amountSats}), 0)` })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.cardId, cardId),
        eq(transactionsTable.direction, "out"),
        eq(transactionsTable.status, "completed"),
        gte(transactionsTable.createdAt, todayUtc),
      ),
    );

  const spentToday = Number(spentRow?.totalSats ?? 0);
  if (spentToday + amountSats > dailyLimitSats) {
    res.json({ status: "ERROR", reason: "Daily spending limit would be exceeded" });
    return;
  }

  // ── LUD-21 PIN verification ───────────────────────────────────────────────
  if (pinHash) {
    const amountMsats = amountSats * 1000;
    // null threshold = always required (wire value 0 means all amounts qualify)
    const pinRequired = amountMsats >= (pinLimitMsats ?? 0);

    if (pinRequired) {
      if (!pinParam) {
        res.json({ status: "ERROR", reason: "PIN required" });
        return;
      }

      const pinMatch = await verifyCardPin(pinParam, pinHash);
      if (!pinMatch) {
        const newFailCount = pinFailCount + 1;
        if (newFailCount >= 3) {
          await db
            .update(cardsTable)
            .set({ pinFailCount: newFailCount, pinLockedAt: new Date() })
            .where(eq(cardsTable.id, cardId));
          logger.warn({ cardId }, "Card PIN locked after 3 failed attempts");
          res.json({ status: "ERROR", reason: "Incorrect PIN. Card is now locked - unlock it in the app." });
        } else {
          await db
            .update(cardsTable)
            .set({ pinFailCount: newFailCount })
            .where(eq(cardsTable.id, cardId));
          logger.warn({ cardId, failCount: newFailCount }, "Card PIN mismatch");
          res.json({ status: "ERROR", reason: `Incorrect PIN. ${3 - newFailCount} attempt(s) remaining.` });
        }
        return;
      }

      // PIN matched - reset fail counter
      await db
        .update(cardsTable)
        .set({ pinFailCount: 0 })
        .where(eq(cardsTable.id, cardId));
    }
  }

  // ── Per-card in-flight guard ──────────────────────────────────────────────
  // A pending send on this card means a previous tap's outcome is still
  // unresolved (ambiguous relay timeout). Paying again now is exactly how the
  // triple-charge incident happened - block until it resolves. The background
  // reconciler finalizes pending sends within minutes, and the window bounds
  // the block even if it cannot.
  const guardCutoff = new Date(Date.now() - 15 * 60 * 1000);
  const [inflightTx] = await db
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.cardId, cardId),
        eq(transactionsTable.direction, "out"),
        eq(transactionsTable.status, "pending"),
        gte(transactionsTable.createdAt, guardCutoff),
      ),
    )
    .limit(1);
  if (inflightTx) {
    logger.warn({ cardId, pendingTxId: inflightTx.id }, "Bolt Card tap rejected - previous payment still unresolved");
    res.json({ status: "ERROR", reason: "A previous payment on this card is still processing - do NOT tap again. Check the openLN app first." });
    return;
  }

  // ── Live balance check against the account's Veil wallet ─────────────────
  // Veil is the source of truth for balances - the legacy DB balance column is
  // no longer used. Veil charges 1% on outgoing payments, so require that
  // headroom up front for a clear error; Veil still enforces authoritatively.
  const nwcUrl = await getAccountNwcUrl(cardAccountId);
  if (!nwcUrl) {
    // Lightning-address and unset accounts have no spendable wallet -
    // bolt card payments need an NWC (Veil or custom) wallet.
    res.json({ status: "ERROR", reason: "Card spending requires a connected wallet (Veil or NWC) - lightning address accounts are receive-only" });
    return;
  }

  // No balance pre-check here on purpose. It is only advisory (Veil enforces
  // the real limit on pay_invoice and returns an insufficient-balance error we
  // surface), but it adds a second relay round-trip to the tap. On the flaky
  // Veil relay a get_balance can hang for the full relay timeout, which alone
  // blows the POS device's HTTP deadline and produces a -11 error. Keeping the
  // tap to a single relay call (pay_invoice) is what makes it respond in time.

  // ── Execute payment via the account's Veil wallet ─────────────────────────
  // Both in-network and external invoices are paid the same way - the invoice
  // is a real Lightning invoice (bitPOS merchant invoices live on the
  // merchant's Veil wallet), and the invoice monitor settles the receiver side.
  //
  // The whole pay + resolve sequence is raced against a hard response budget:
  // POS devices time out around ~15-20s and show a device error (-11) if the
  // callback stalls (production incident: 72s hold). If the budget expires,
  // respond "still processing" and let the work finish in the background -
  // the DB row is finalized either way and the in-flight guard clears.
  const executePayment = async (): Promise<{ status: "OK" } | { status: "ERROR"; reason: string }> => {
    try {
      const { paymentHash, feeSats } = await processExternalPayment(
        cardAccountId,
        pr,
        amountSats,
        undefined,
        `Bolt Card payment (${cardLabel})`,
        nwcUrl,
        cardId,
      );
      logger.info({ cardId, accountId: cardAccountId, amountSats, feeSats, paymentHash }, "Bolt Card payment completed via Veil");

      // Fast-path settlement for in-network invoices: if this bolt11 belongs to a
      // bitPOS merchant, mark it paid immediately so the POS confirms in real time
      // instead of waiting for the push subscription or fallback sweep. The settle
      // is idempotent (conditional on paidAt IS NULL), so a concurrent monitor
      // notification cannot double-settle.
      try {
        await settleInvoiceByPaymentHash(paymentHash, new Date());
      } catch (settleErr) {
        logger.warn({ cardId, paymentHash, settleErr }, "Fast-path invoice settlement failed - invoice monitor will settle");
      }

      return { status: "OK" };
    } catch (err: unknown) {
      // AMBIGUOUS outcome (relay reply timeout): the payment may have succeeded.
      // Never report failure here - that invites a retap and a double charge
      // (production incident: 3 taps, 3 real payments, 3 "failed" screens).
      // Resolve the true outcome against the card's wallet before responding.
      if (err instanceof AmbiguousPaymentError) {
        logger.warn(
          { cardId, accountId: cardAccountId, amountSats, err: err.message },
          "Bolt Card payment outcome ambiguous - resolving before responding",
        );
        const outcome = await resolveAmbiguousPayment(err, nwcUrl);
        if (outcome.status === "completed") {
          logger.info(
            { cardId, accountId: cardAccountId, amountSats, paymentHash: outcome.paymentHash },
            "Bolt Card ambiguous payment resolved: settled",
          );
          if (outcome.paymentHash) {
            try {
              await settleInvoiceByPaymentHash(outcome.paymentHash, new Date());
            } catch (settleErr) {
              logger.warn({ cardId, paymentHash: outcome.paymentHash, settleErr }, "Fast-path invoice settlement failed - invoice monitor will settle");
            }
          }
          return { status: "OK" };
        }
        if (outcome.status === "failed") {
          logger.info({ cardId, accountId: cardAccountId, amountSats }, "Bolt Card ambiguous payment resolved: failed");
          return { status: "ERROR", reason: "Payment failed. Please try again." };
        }
        // Still unresolved: the payment may well have settled (relay reply loss
        // is common). In LNURL-withdraw, callback OK means "request accepted -
        // payment on the way"; the POS confirms only when ITS invoice is paid.
        // Responding ERROR here is what made the device show "failed" on
        // successful payments and invited double-tap retries. If the payment
        // truly failed, the POS simply never sees its invoice paid, and the
        // reconciler finalizes our row - the customer is not charged.
        logger.warn({ cardId, accountId: cardAccountId, amountSats }, "Bolt Card payment still unresolved - accepting (OK), reconciler will finalize");
        return { status: "OK" };
      }
      logger.error({ cardId, accountId: cardAccountId, amountSats, err }, "Bolt Card payment failed");
      return { status: "ERROR", reason: payFailureReason(err) };
    }
  };

  const work = executePayment();
  // Remaining time before the POS device's HTTP deadline, measured from request
  // arrival so slow prechecks (e.g. a stalled balance read) do not eat into the
  // margin. Floored so the payment always gets a brief chance to confirm on the
  // fast path even if prechecks were slow.
  const remainingMs = Math.max(
    CARD_TAP_MIN_PAYMENT_WINDOW_MS,
    CARD_TAP_GLOBAL_DEADLINE_MS - (Date.now() - requestStart),
  );
  let budgetTimer: NodeJS.Timeout | undefined;
  const budget = new Promise<null>((resolve) => {
    budgetTimer = setTimeout(() => resolve(null), remainingMs);
    budgetTimer.unref?.();
  });
  const result = await Promise.race([work, budget]);
  if (budgetTimer) clearTimeout(budgetTimer);

  if (result) {
    res.json(result);
    return;
  }

  // Budget expired - the payment is dispatched and all card checks passed, so
  // accept the withdraw request (status OK) per LNURL-withdraw semantics: OK
  // means "payment on the way", NOT "payment settled". The POS device shows
  // success only when its own invoice is paid, so if the payment ultimately
  // fails the POS just never confirms - it does NOT falsely show paid. The
  // previous ERROR-on-budget response made the device show "server returned
  // -11" on payments that settled seconds later.
  logger.warn(
    { cardId, accountId: cardAccountId, amountSats, waitedMs: Date.now() - requestStart },
    "Bolt Card callback response budget expired - accepting (OK), work continues in background",
  );
  work.then((late) => {
    logger.info({ cardId, accountId: cardAccountId, amountSats, late }, "Bolt Card background payment work finished after budget");
  }).catch((err) => {
    logger.error({ cardId, err }, "Bolt Card background payment work errored after budget");
  });
  res.json({ status: "OK" });
}

// Total time, measured from request arrival, that the card callback may hold
// the POS device's HTTP request. Field evidence: the device aborts with error
// -11 well before 12s, so we must answer fast. On the happy path payInvoice
// replies in ~2-3s and we return confirmed settlement; if slower (flaky relay),
// we answer OK ("payment on the way") and finish in the background. The POS
// confirms via its own invoice settlement, so answering early is safe and never
// shows a false "paid".
const CARD_TAP_GLOBAL_DEADLINE_MS = 6_000;

// Minimum window the payment step always gets, even if prior steps ran slow, so
// a fast in-network settlement can still confirm within the same tap.
const CARD_TAP_MIN_PAYMENT_WINDOW_MS = 1_500;

/** Map definitive pay failures to actionable messages; generic otherwise. */
function payFailureReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/insufficient/i.test(msg)) return "Insufficient balance";
  if (/expired/i.test(msg)) return "Invoice expired - generate a new invoice and tap again";
  if (/no.?route|route not found/i.test(msg)) return "No route to destination - please try again";
  return "Payment failed. Please try again.";
}

/** Router adapter only. Payment/check/timeout behavior above is the bitPOS port. */
export async function handleCardTapRoute(req: IncomingMessage, res: ServerResponse, u: URL): Promise<boolean> {
  const match=u.pathname.match(/^\/card\/([^/]+)(\/callback)?$/);
  if (!match || req.method!=="GET") return false;
  const respond: Response={json(value){res.writeHead(200,{"content-type":"application/json","cache-control":"no-store","referrer-policy":"no-referrer"});res.end(JSON.stringify(value));}};
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(match[1])) {respond.json({status:"ERROR",reason:"Card not found"});return true;}
  const request: Request={params:{cardId:match[1]},query:Object.fromEntries(u.searchParams)};
  if(match[2])await callback(request,respond);else await tap(request,respond);
  return true;
}

