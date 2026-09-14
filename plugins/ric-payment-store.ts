import { pool } from "../core/db/index.js";
import { encrypt, decrypt } from "../core/money/encrypt.js";
import { processExternalPayment, AmbiguousPaymentError, finalizePendingSend } from "../core/money/feeEngine.js";
import { lookupOutgoingPayment } from "../core/money/nwc.js";
import { extractPaymentHash } from "../core/money/lnAddress.js";
import { logger } from "../core/money/logger.js";
import { emitAccountEvent } from "../core/events.js";

export const SEND_CHECKOUT_SECONDS = 600;
export const SEND_RESPONSE_BUDGET_MS = 1_200;
export const validCheckoutKey = (key: unknown): key is string => typeof key === "string" && /^[0-9a-f]{64}$/.test(key);
export const validSendAmount = (amount: unknown): amount is number => typeof amount === "number" && Number.isSafeInteger(amount) && amount > 0 && Number.isSafeInteger(amount * 1000);
export type Checkout = {
  k1: string; account_id: string; amount_sats: string; state: string; channel: "qr" | "card" | null;
  payer_nwc_encrypted: string; bolt11: string | null; payment_hash: string | null;
  recipient_account_id: string | null; card_id: string | null; outgoing_tx_id: string | null;
  receipt_tx_id: string | null; dispatched_at: Date | null; paid_at: Date | null;
  fee_sats: string; failure_reason: string | null; expires_at: Date;
};
export class CheckoutError extends Error {
  constructor(readonly status: number, message: string, readonly code = "SEND_REJECTED") { super(message); }
}

/** Validation only. Preserve the original invoice and the verbatim payer path. */
export function validateSendInvoice(invoice: string, sats: number): string {
  if (!invoice || invoice.length > 8192 || (invoice !== invoice.toLowerCase() && invoice !== invoice.toUpperCase())) throw new CheckoutError(400, "Invalid invoice");
  const lower = invoice.toLowerCase();
  const separator = lower.lastIndexOf("1");
  const amount = lower.slice(0, separator).match(/^ln(?:bc|tb|bcrt)([0-9]+)([munp]?)$/);
  if (!amount || !/^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(lower.slice(separator + 1))) throw new CheckoutError(400, "Invalid invoice");
  const n = BigInt(amount[1]);
  const multiplier: Record<string, bigint> = { "": 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n };
  const msats = amount[2] === "p" ? (n % 10n === 0n ? n / 10n : -1n) : n * multiplier[amount[2]];
  if (msats !== BigInt(sats) * 1000n) throw new CheckoutError(400, "Invoice amount does not match the authorized send amount", "AMOUNT_MISMATCH");
  try { return extractPaymentHash(invoice); } catch { throw new CheckoutError(400, "Invalid invoice"); }
}
export async function readCheckout(k1: string, accountId?: string): Promise<Checkout | undefined> {
  if (!validCheckoutKey(k1)) return undefined;
  const result = await pool.query<Checkout>("SELECT * FROM ric_send_checkouts WHERE k1=$1" + (accountId ? " AND account_id=$2" : ""), accountId ? [k1, accountId] : [k1]);
  return result.rows[0];
}
export async function expireUnusedCheckout(k1: string): Promise<void> {
  await pool.query("UPDATE ric_send_checkouts SET state='expired',updated_at=now() WHERE k1=$1 AND dispatched_at IS NULL AND state IN ('ready','preparing') AND expires_at<=now()", [k1]);
}
export async function createCheckout(k1: string, accountId: string, amount: number, nwcUrl: string): Promise<Checkout> {
  await pool.query("INSERT INTO ric_send_checkouts(k1,account_id,amount_sats,payer_nwc_encrypted,expires_at) VALUES($1,$2,$3,$4,now()+interval '600 seconds') ON CONFLICT(k1) DO NOTHING", [k1, accountId, amount, encrypt(nwcUrl)]);
  const row = await readCheckout(k1, accountId);
  if (!row) throw new CheckoutError(404, "Checkout not found");
  if (Number(row.amount_sats) !== amount) throw new CheckoutError(409, "Checkout amount cannot change");
  return row;
}
export function checkoutView(row: Checkout) {
  return { k1: row.k1, status: ["ready", "preparing", "pending"].includes(row.state) ? "pending" : row.state,
    phase: row.state, dispatched: !!row.dispatched_at, doNotRetry: !!row.dispatched_at,
    ...(row.state === "paid" ? { paymentHash: row.payment_hash } : {}), expiresAt: row.expires_at,
    ...(row.failure_reason ? { reason: row.failure_reason } : {}) };
}
export async function cancelCheckout(k1: string, accountId: string): Promise<Checkout> {
  await pool.query("UPDATE ric_send_checkouts SET state='cancelled',updated_at=now() WHERE k1=$1 AND account_id=$2 AND dispatched_at IS NULL AND state IN ('ready','preparing')", [k1, accountId]);
  const row = await readCheckout(k1, accountId);
  if (!row) throw new CheckoutError(404, "Checkout not found");
  return row;
}
export async function claimCard(k1: string, accountId: string, cardId: string, recipientAccountId: string): Promise<Checkout | undefined> {
  return (await pool.query<Checkout>("UPDATE ric_send_checkouts SET channel='card',card_id=$3,recipient_account_id=$4,state='preparing',updated_at=now() WHERE k1=$1 AND account_id=$2 AND state='ready' AND expires_at>now() RETURNING *", [k1, accountId, cardId, recipientAccountId])).rows[0];
}
export async function commitDispatch(row: Checkout, invoice: string, hash: string, channel: "qr" | "card"): Promise<Checkout | undefined> {
  // This durable CAS is the only admission point to processExternalPayment.
  // No restart or status path calls that function for an already committed row.
  try {
    return (await pool.query<Checkout>("UPDATE ric_send_checkouts SET channel=$2,bolt11=$3,payment_hash=$4,state='pending',dispatched_at=now(),updated_at=now() WHERE k1=$1 AND state=$5 AND expires_at>now() AND dispatched_at IS NULL RETURNING *", [row.k1, channel, invoice, hash, channel === "qr" ? "ready" : "preparing"])).rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new CheckoutError(409, "Invoice already belongs to another checkout");
    throw err;
  }
}
export async function failPreparation(k1: string): Promise<void> {
  await pool.query("UPDATE ric_send_checkouts SET state='failed',failure_reason='Could not create the recipient invoice. No payment was sent.',updated_at=now() WHERE k1=$1 AND state='preparing' AND dispatched_at IS NULL", [k1]);
}
async function outgoing(row: Checkout) {
  return (await pool.query<{id:string;status:string}>("SELECT id,status FROM transactions WHERE account_id=$1 AND direction='out' AND type='send' AND payment_hash=$2 AND bolt11=$3 ORDER BY created_at DESC LIMIT 1", [row.account_id, row.payment_hash, row.bolt11])).rows[0];
}
async function markPaid(row: Checkout, hash: string, fees: number): Promise<void> {
  const client = await pool.connect(); let changed = false;
  try {
    await client.query("BEGIN");
    const locked = (await client.query<Checkout>("SELECT * FROM ric_send_checkouts WHERE k1=$1 FOR UPDATE", [row.k1])).rows[0];
    if (!locked || !locked.dispatched_at || locked.state === "paid") { await client.query("COMMIT"); return; }
    let receiptId = locked.receipt_tx_id;
    if (locked.channel === "card" && locked.recipient_account_id && !receiptId) {
      const existing = await client.query<{id:string}>("SELECT id FROM transactions WHERE account_id=$1 AND direction='in' AND payment_hash=$2 LIMIT 1", [locked.recipient_account_id, hash]);
      receiptId = existing.rows[0]?.id ?? (await client.query<{id:string}>("INSERT INTO transactions(account_id,card_id,amount_sats,direction,type,status,bolt11,payment_hash,memo) VALUES($1,$2,$3,'in','receive','completed',$4,$5,'openLN send to card') RETURNING id", [locked.recipient_account_id, locked.card_id, locked.amount_sats, locked.bolt11, hash])).rows[0].id;
    }
    await client.query("UPDATE ric_send_checkouts SET state='paid',paid_at=now(),payment_hash=$2,fee_sats=$3,receipt_tx_id=$4,failure_reason=NULL,updated_at=now() WHERE k1=$1", [row.k1, hash, fees, receiptId]);
    await client.query("COMMIT"); changed = true;
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  if (changed) {
    emitAccountEvent(row.account_id, "payment", { paymentHash: hash, status: "paid" });
    if (row.recipient_account_id) emitAccountEvent(row.recipient_account_id, "payment", { paymentHash: hash, status: "paid" });
  }
}
async function markFailed(row: Checkout): Promise<void> {
  await pool.query("UPDATE ric_send_checkouts SET state='failed',failure_reason='Wallet reported payment failed',updated_at=now() WHERE k1=$1 AND state='pending'", [row.k1]);
}
const work = new Map<string, Promise<void>>();
export function runCheckoutWork(k1: string, fn: () => Promise<void>): Promise<void> {
  const existing = work.get(k1); if (existing) return existing;
  const promise = fn().catch(err => { logger.error({ err }, "RIC checkout work remains recoverable"); }).finally(() => work.delete(k1));
  work.set(k1, promise); return promise;
}
export async function executeCommittedCheckout(row: Checkout): Promise<void> {
  try {
    const result = await processExternalPayment(row.account_id, row.bolt11!, Number(row.amount_sats), undefined,
      row.channel === "qr" ? "RIC send (QR)" : "RIC send to card", decrypt(row.payer_nwc_encrypted));
    await markPaid(row, result.paymentHash, result.feeSats);
  } catch (err) {
    const tx = await outgoing(row);
    if (tx) await pool.query("UPDATE ric_send_checkouts SET outgoing_tx_id=$2,updated_at=now() WHERE k1=$1", [row.k1, tx.id]);
    // A generic DB/transport failure after pay is not a payment rejection.
    // Even a locally failed row needs wallet proof before checkout failure.
    if (err instanceof AmbiguousPaymentError || tx?.status !== "failed") return;
    const code = (err as {code?:string}).code;
    if (["INSUFFICIENT_BALANCE", "QUOTA_EXCEEDED", "UNAUTHORIZED", "RESTRICTED"].includes(code ?? "")) await markFailed(row);
  }
}
const checking = new Map<string, Promise<void>>();
export function reconcileCheckout(row: Checkout): Promise<void> {
  const existing = checking.get(row.k1); if (existing) return existing;
  if (row.state !== "pending" || !row.bolt11 || !row.dispatched_at || checking.size >= 4) return Promise.resolve();
  const promise = (async () => {
    await pool.query("UPDATE ric_send_checkouts SET checked_at=now() WHERE k1=$1", [row.k1]);
    // Pin the payer identity from authorization time, including across restarts.
    // NOT_FOUND and all lookup errors remain pending; never infer failure by age.
    const proof = await lookupOutgoingPayment(row.bolt11!, decrypt(row.payer_nwc_encrypted));
    const tx = await outgoing(row);
    if (proof.paid && (!proof.paymentHash || proof.paymentHash === row.payment_hash)) {
      const fees = Math.ceil((proof.feesPaidMsats ?? 0) / 1000);
      if (tx) await finalizePendingSend(tx.id, {status:"completed",paymentHash:row.payment_hash!,feeSats:fees});
      await markPaid(row, row.payment_hash!, fees);
    } else if (proof.state === "failed") {
      if (tx) await finalizePendingSend(tx.id, {status:"failed",reason:"Wallet reported payment failed"});
      await markFailed(row);
    }
  })().catch(err => { logger.warn({ errorClass: err instanceof Error ? err.name : "lookup" }, "RIC send outcome unconfirmed; retaining pending"); }).finally(() => checking.delete(row.k1));
  checking.set(row.k1, promise); return promise;
}
export async function waitForCheckout(k1: string, waiting: Promise<void>): Promise<Checkout> {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([waiting, new Promise<void>(resolve => { timer = setTimeout(resolve, SEND_RESPONSE_BUDGET_MS); timer.unref?.(); })]); }
  finally { if (timer) clearTimeout(timer); }
  const row = await readCheckout(k1); if (!row) throw new CheckoutError(404, "Checkout not found"); return row;
}
let recoveryTimer: NodeJS.Timeout | undefined;
let sweeping = false;
/** Once at server startup. Read/lookup recovery only, never re-dispatches a pay. */
export function startRicPaymentRecovery(): () => void {
  if (recoveryTimer) return () => {};
  const sweep = async () => {
    if (sweeping) return; sweeping = true;
    try {
      await pool.query("UPDATE ric_send_checkouts SET state='expired',updated_at=now() WHERE dispatched_at IS NULL AND state IN ('ready','preparing') AND expires_at<=now()");
      const rows = (await pool.query<Checkout>("SELECT * FROM ric_send_checkouts WHERE state='pending' ORDER BY checked_at NULLS FIRST,created_at LIMIT 4")).rows;
      await Promise.all(rows.map(reconcileCheckout));
    } catch (err) { logger.warn({ err }, "RIC checkout recovery unavailable"); } finally { sweeping = false; }
  };
  void sweep(); recoveryTimer = setInterval(() => { void sweep(); }, 20_000); recoveryTimer.unref();
  return () => { if (recoveryTimer) clearInterval(recoveryTimer); recoveryTimer = undefined; };
}
