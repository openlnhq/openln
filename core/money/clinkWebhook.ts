/**
 * CLINK offer webhooks - the receiving end of Lightning.Pub's paid callback.
 *
 * A noffer is a static receive code whose wallet (the Lightning.Pub node
 * service behind ShockWallet) can carry a callback URL per offer. When an
 * invoice minted through the offer is paid, Lightning.Pub fires exactly one
 * GET (no retries, 5s timeout - verified against its source; a startup
 * recovery pass may repeat one):
 *
 *   GET <callback url>?invoice=<bolt11>&amount=<paid amount>&ok=true
 *   Authorization: Bearer <token>          (when a bearer was configured)
 *
 * `invoice`/`amount` appear only when the merchant's callback URL template
 * includes {invoice}/{amount} - which the wallet form enforces (at least one
 * placeholder required). openLN hands the merchant a template with both; the
 * invoice echo is what identifies the sale.
 *
 * Why it matters: without this push nothing on our side can observe a direct
 * payment to a CLINK offer, so the direct fallback refuses (policy A, like a
 * verify-less Lightning Address). With the hook configured the wallet itself
 * becomes the observer: wrap-unavailable sales settle directly, and every
 * wrapped sale gets an independent confirmation record.
 *
 * Money-safety rules baked in here:
 *  - auth is the per-connection bearer secret (constant-time compare),
 *    scoped to exactly one account's pending invoices;
 *  - a callback never settles anything but an UNPAID DIRECT row whose exact
 *    bolt11 it echoes. Wrapped rows are mid-flight: the push only records a
 *    corroboration event and nudges the wrap driver (which dedupes);
 *  - amount is cross-checked when present (sats or msats both accepted -
 *    Lightning.Pub builds differ), a mismatch blocks settlement;
 *  - settlement is the shared CAS path (settleInvoiceByPaymentHash), so
 *    repeated or racing callbacks can never double-settle.
 */
import { db, accountConnectionsTable, pendingInvoicesTable } from "../db/index.js";
import { and, eq } from "drizzle-orm";
import { encrypt } from "./encrypt.js";
import { resolveNwcUrl } from "./nwc.js";
import { settleInvoiceByPaymentHash } from "./invoiceMonitor.js";
import { kickWrap } from "./wrapDriver.js";
import { recordPaymentEvent } from "./paymentLog.js";
import { logger } from "./logger.js";
import { CLINK_HOOK_ID_RX, clinkHookBearerMatches, generateClinkHookId, generateClinkHookSecret } from "./clink.js";

export type ClinkHookCredentials = { hookId: string; token: string };

/** The two paste-ready paths Settings shows: plain base URL + URI template. */
export function clinkHookPaths(hookId: string): { path: string; templatePath: string } {
  // {?invoice,amount} is RFC 6570 form-style query expansion - the string the
  // wallet's Raw URL field accepts and expands to ?invoice=...&amount=...
  return {
    path: `/api/clink/hook/${hookId}`,
    templatePath: `/api/clink/hook/${hookId}{?invoice,amount}`,
  };
}

/**
 * Ensure a noffer connection owns its hook pair (id + bearer secret).
 * Generates and persists on first call; lazy so connections saved before
 * the hook existed get one on their first read. Null for other kinds.
 */
export async function ensureClinkHook(connectionId: string): Promise<ClinkHookCredentials | null> {
  const [row] = await db
    .select({
      id: accountConnectionsTable.id,
      kind: accountConnectionsTable.kind,
      hookId: accountConnectionsTable.clinkHookId,
      secretEnc: accountConnectionsTable.clinkHookSecretEncrypted,
    })
    .from(accountConnectionsTable)
    .where(eq(accountConnectionsTable.id, connectionId));
  if (!row || row.kind !== "noffer") return null;
  if (row.hookId && CLINK_HOOK_ID_RX.test(row.hookId) && row.secretEnc) {
    const token = resolveNwcUrl(row.secretEnc);
    if (token) return { hookId: row.hookId, token };
  }
  const hookId = row.hookId && CLINK_HOOK_ID_RX.test(row.hookId) ? row.hookId : generateClinkHookId();
  const token = generateClinkHookSecret();
  await db
    .update(accountConnectionsTable)
    .set({ clinkHookId: hookId, clinkHookSecretEncrypted: encrypt(token), updatedAt: new Date() })
    .where(eq(accountConnectionsTable.id, connectionId));
  return { hookId, token };
}

/**
 * New bearer secret, same hook id: the merchant keeps the URL in the wallet
 * and swaps only the token - the smallest possible re-paste.
 */
export async function rotateClinkHook(connectionId: string): Promise<ClinkHookCredentials | null> {
  const [row] = await db
    .select({ id: accountConnectionsTable.id, kind: accountConnectionsTable.kind, hookId: accountConnectionsTable.clinkHookId })
    .from(accountConnectionsTable)
    .where(eq(accountConnectionsTable.id, connectionId));
  if (!row || row.kind !== "noffer") return null;
  const hookId = row.hookId && CLINK_HOOK_ID_RX.test(row.hookId) ? row.hookId : generateClinkHookId();
  const token = generateClinkHookSecret();
  await db
    .update(accountConnectionsTable)
    .set({ clinkHookId: hookId, clinkHookSecretEncrypted: encrypt(token), updatedAt: new Date() })
    .where(eq(accountConnectionsTable.id, connectionId));
  return { hookId, token };
}

export type ClinkWebhookOutcome = { status: number; body: Record<string, unknown> };

/**
 * Handle one Lightning.Pub paid callback. NEVER throws - always answers with
 * a status the wallet can log; must answer within the wallet's 5s budget
 * (all steps here are small DB operations + one CAS settle).
 */
export async function processClinkWebhook(input: {
  hookId: string;
  searchParams: URLSearchParams;
  authorization: string | null;
}): Promise<ClinkWebhookOutcome> {
  try {
    const [conn] = await db
      .select({
        id: accountConnectionsTable.id,
        accountId: accountConnectionsTable.accountId,
        kind: accountConnectionsTable.kind,
        secretEnc: accountConnectionsTable.clinkHookSecretEncrypted,
      })
      .from(accountConnectionsTable)
      .where(eq(accountConnectionsTable.clinkHookId, input.hookId));
    if (!conn || conn.kind !== "noffer") return { status: 404, body: { ok: false, error: "Unknown webhook" } };
    const secret = resolveNwcUrl(conn.secretEnc);
    if (!secret) return { status: 404, body: { ok: false, error: "Unknown webhook" } };
    if (!clinkHookBearerMatches(input.authorization, secret)) return { status: 401, body: { ok: false, error: "Unauthorized" } };

    const invoice = (input.searchParams.get("invoice") ?? "").trim().toLowerCase();
    if (!invoice) return { status: 400, body: { ok: false, error: "Missing invoice parameter" } };

    // Wrapped rows carry the merchant invoice in merchant_bolt11; direct rows
    // ARE the invoice. Scoped to the hook's own account - a secret must never
    // touch another account's rows even if a bolt11 string leaked otherwise.
    let [inv] = await db
      .select()
      .from(pendingInvoicesTable)
      .where(and(eq(pendingInvoicesTable.accountId, conn.accountId), eq(pendingInvoicesTable.merchantBolt11, invoice)));
    if (!inv) {
      [inv] = await db
        .select()
        .from(pendingInvoicesTable)
        .where(and(eq(pendingInvoicesTable.accountId, conn.accountId), eq(pendingInvoicesTable.bolt11, invoice)));
    }
    if (!inv) {
      // Not ours - the same offer can also serve lightning-address traffic.
      // Acknowledge so the wallet's log stays clean; nothing to record.
      logger.info({ hookId: input.hookId, accountId: conn.accountId }, "CLINK webhook: invoice is not a tracked openLN payment - ignored");
      return { status: 200, body: { ok: true, tracked: false } };
    }

    const amountRaw = input.searchParams.get("amount");
    const amountNum = Number(amountRaw);
    if (amountRaw !== null && Number.isFinite(amountNum) && amountNum > 0 && amountNum !== inv.amountSats && amountNum !== inv.amountSats * 1000) {
      recordPaymentEvent({
        paymentId: inv.paymentHash,
        accountId: conn.accountId,
        kind: "receive",
        event: "clink.hook_amount_mismatch",
        status: "fail",
        method: "clink",
        message: `CLINK webhook amount ${amountNum} does not match the invoice's ${inv.amountSats} sats - settlement blocked`,
        paymentHash: inv.paymentHash,
        amountSats: inv.amountSats,
      });
      return { status: 200, body: { ok: true, settled: false, reason: "amount" } };
    }

    if (inv.wrapStatus) {
      // Wrapped sale: the merchant invoice being paid is a mid-flight step;
      // only the wrap state machine settles it. Record the independent
      // signal and nudge the driver (it dedupes internally).
      recordPaymentEvent({
        paymentId: inv.paymentHash,
        accountId: conn.accountId,
        kind: "wrap",
        event: "clink.hook_paid",
        status: "info",
        method: "clink",
        message: `CLINK webhook: merchant invoice paid (wrap ${inv.wrapStatus})`,
        paymentHash: inv.paymentHash,
        merchantPaymentHash: inv.merchantPaymentHash,
        amountSats: inv.amountSats,
      });
      kickWrap(inv.paymentHash);
      return { status: 200, body: { ok: true, settled: false, wrap: inv.wrapStatus } };
    }

    if (inv.paidAt) return { status: 200, body: { ok: true, settled: false, alreadyPaid: true } };

    const settled = await settleInvoiceByPaymentHash(inv.paymentHash, new Date());
    recordPaymentEvent({
      paymentId: inv.paymentHash,
      accountId: conn.accountId,
      kind: "receive",
      event: settled ? "clink.settled_by_hook" : "clink.hook_noop",
      status: settled ? "success" : "info",
      method: "clink",
      message: settled
        ? `CLINK webhook settled a direct sale (${inv.amountSats} sats)`
        : "CLINK webhook found the invoice already settled by another path",
      paymentHash: inv.paymentHash,
      amountSats: inv.amountSats,
    });
    return { status: 200, body: { ok: true, settled } };
  } catch (err) {
    // The wallet gets a 5s budget with no retries - an internal fault must
    // still answer promptly and leave a trace.
    logger.warn({ err, hookId: input.hookId }, "CLINK webhook: processing failed");
    return { status: 500, body: { ok: false, error: "Processing failed" } };
  }
}
