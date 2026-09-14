import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, accountsTable, entitiesTable, cardsTable } from "../core/db/index.js";
import { verifySendPin, SEND_PIN_UNSET } from "../core/auth/send-pin.js";
import { encodeLnurl, decryptSunP, verifySunC } from "../core/money/boltcard.js";
import { getAccountNwcUrl, makeInvoice } from "../core/money/nwc.js";
import { decrypt } from "../core/money/encrypt.js";
import { resolveWalletSource } from "../core/money/walletSource.js";
import { DOMAIN } from "../core/domain.js";
import {
  type Checkout, CheckoutError, validCheckoutKey, validSendAmount, validateSendInvoice,
  readCheckout, createCheckout, expireUnusedCheckout, checkoutView, cancelCheckout,
  claimCard, commitDispatch, failPreparation, executeCommittedCheckout, runCheckoutWork,
  reconcileCheckout, waitForCheckout,
} from "./ric-payment-store.js";
export { startRicPaymentRecovery } from "./ric-payment-store.js";

const respond = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end(JSON.stringify(data)); return true;
};
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 16_384) throw new CheckoutError(413, "Request too large"); }
  try { return JSON.parse(raw || "{}"); } catch { throw new CheckoutError(400, "Invalid JSON"); }
}
async function checkSendPin(accountId: string, pin: string): Promise<void> {
  if(!pin)throw new CheckoutError(400,'PIN required');
  const client=await pool.connect();let reject:CheckoutError|undefined;
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO ric_send_pin_attempts(account_id) VALUES($1) ON CONFLICT DO NOTHING",[accountId]);
    const attempt=(await client.query("SELECT failures,blocked_until,window_started_at FROM ric_send_pin_attempts WHERE account_id=$1 FOR UPDATE",[accountId])).rows[0];
    if(attempt.blocked_until && new Date(attempt.blocked_until).getTime()>Date.now())reject=new CheckoutError(429,'Send authorization temporarily locked. Wait before trying again.','SEND_LOCKED');
    else {
      const entity=(await client.query("SELECT e.pin_hash FROM accounts a JOIN entities e ON e.id=a.entity_id WHERE a.id=$1",[accountId])).rows[0];
      if(!entity?.pin_hash || entity.pin_hash===SEND_PIN_UNSET)reject=new CheckoutError(403,'Sending is not set up for this account. Configure a send code in openLN Settings.');
      else if(!await verifySendPin(pin,entity.pin_hash)) {
        const age=Date.now()-new Date(attempt.window_started_at).getTime();
        const failures=(age>900000?0:attempt.failures)+1;
        await client.query("UPDATE ric_send_pin_attempts SET failures=$2,window_started_at=CASE WHEN $3 THEN now() ELSE window_started_at END,blocked_until=CASE WHEN $2>=5 THEN now()+interval '15 minutes' ELSE NULL END WHERE account_id=$1",[accountId,failures,age>900000]);
        reject=new CheckoutError(failures>=5?429:401,failures>=5?'Send authorization temporarily locked.':'Invalid PIN');
      } else await client.query('DELETE FROM ric_send_pin_attempts WHERE account_id=$1',[accountId]);
    }
    await client.query('COMMIT');
  } catch(err) {await client.query('ROLLBACK');throw err;} finally {client.release();}
  if(reject)throw reject;
}
async function requireCheckout(k1: string, accountId?: string): Promise<Checkout> {
  if (!validCheckoutKey(k1)) throw new CheckoutError(400, "Invalid checkout key");
  await expireUnusedCheckout(k1);
  const row = await readCheckout(k1, accountId);
  if (!row) throw new CheckoutError(404, "Checkout not found"); return row;
}
function sendResponse(res: ServerResponse, row: Checkout) {
  if (row.state === "paid") return respond(res, 200, { ...checkoutView(row), status: "OK", paymentStatus: "paid" });
  if (["ready", "preparing", "pending"].includes(row.state)) return respond(res, 202, { ...checkoutView(row), status: "pending", doNotRetry: true });
  return respond(res, 409, { ...checkoutView(row), error: row.failure_reason ?? "Checkout is no longer available" });
}

/** Shared QR/NFC checkout. Route composition only; the core payer is unchanged. */
export async function handleRicPaymentRoute(req: IncomingMessage, res: ServerResponse, url: URL, account: {id:string} | undefined): Promise<boolean> {
  const statusPath = url.pathname.match(/^\/api\/pos\/withdraw\/([^/]+)\/status$/);
  const cancelPath = url.pathname.match(/^\/api\/pos\/withdraw\/([^/]+)\/cancel$/);
  const create = url.pathname === "/api/pos/withdraw";
  const toCard = url.pathname === "/api/pos/send-to-card";
  const lnurl = url.pathname === "/api/pos/withdraw/callback";
  if (!statusPath && !cancelPath && !create && !toCard && !lnurl) return false;
  let k1 = String(url.searchParams.get("k1") ?? statusPath?.[1] ?? cancelPath?.[1] ?? "");
  let acceptedDispatch = false;
  try {
    if (lnurl) {
      if (req.method !== "GET") throw new CheckoutError(405, "Method not allowed");
      const row = await requireCheckout(k1);
      const invoice = url.searchParams.get("pr") ?? "";
      if (["cancelled", "expired", "failed"].includes(row.state)) throw new CheckoutError(409, "Withdrawal is no longer available");
      if (row.channel === "card") throw new CheckoutError(409, "Checkout already claimed by card send");
      if (!invoice) return respond(res, 200, { tag: "withdrawRequest", callback: `https://${DOMAIN}/api/pos/withdraw/callback`, k1,
        defaultDescription: "openLN send", minWithdrawable: Number(row.amount_sats) * 1000, maxWithdrawable: Number(row.amount_sats) * 1000 });
      const hash = validateSendInvoice(invoice, Number(row.amount_sats));
      if (row.bolt11) {
        if (row.bolt11 !== invoice || row.payment_hash !== hash) throw new CheckoutError(409, "Checkout already bound to another invoice");
        return respond(res, 200, {status:"OK"});
      }
      // Ensure the pinned wallet can be read before committing dispatch.
      decrypt(row.payer_nwc_encrypted);
      const claimed = await commitDispatch(row, invoice, hash, "qr");
      if (!claimed) {
        const current = await requireCheckout(k1);
        if (current.channel === "qr" && current.bolt11 === invoice && current.dispatched_at) return respond(res, 200, {status:"OK"});
        throw new CheckoutError(409, "Checkout is no longer available");
      }
      acceptedDispatch = true;
      const result = await waitForCheckout(k1, runCheckoutWork(k1, () => executeCommittedCheckout(claimed)));
      if (result.state === "failed") return respond(res, 200, {status:"ERROR", reason:"Wallet reported payment failed", dispatched:true});
      return respond(res, 200, {status:"OK"});
    }
    if (!account) throw new CheckoutError(401, "Authentication required");
    if (statusPath) {
      if (req.method !== "GET") throw new CheckoutError(405, "Method not allowed");
      const row = await requireCheckout(k1, account.id);
      const result = row.state === "pending" ? await waitForCheckout(k1, reconcileCheckout(row)) : row;
      return respond(res, 200, checkoutView(result));
    }
    if (cancelPath) {
      if (req.method !== "POST") throw new CheckoutError(405, "Method not allowed");
      await requireCheckout(k1, account.id);
      const row = await cancelCheckout(k1, account.id);
      return respond(res, row.dispatched_at ? 409 : 200, checkoutView(row));
    }
    if (req.method !== "POST") throw new CheckoutError(405, "Method not allowed");
    const value = await body(req);
    const amount = value.amountSats;
    if (!validSendAmount(amount)) throw new CheckoutError(400, "amountSats must be a positive safe integer");
    await checkSendPin(account.id, String(value.pin ?? ""));
    if (create) {
      k1 = value.requestId === undefined ? randomBytes(32).toString("hex") : String(value.requestId);
      if (!validCheckoutKey(k1)) throw new CheckoutError(400, "requestId must be 64 lowercase hex characters");
      const source = await resolveWalletSource(account.id);
      if (source.kind === "none") throw new CheckoutError(400, "Wallet not configured");
      if (source.kind !== "nwc") throw new CheckoutError(400, "Lightning address accounts are receive-only");
      const row = await createCheckout(k1, account.id, amount, source.nwcUrl);
      return respond(res, 200, { lnurlw: encodeLnurl(`https://${DOMAIN}/api/pos/withdraw/callback?k1=${k1}`), k1, expiresAt: row.expires_at });
    }
    k1 = String(value.k1 ?? "");
    if (!k1) throw new CheckoutError(400, "Update RIC firmware before sending to a card. Use QR sending on this version.", "SEND_CHECKOUT_REQUIRED");
    const row = await requireCheckout(k1, account.id);
    if (Number(row.amount_sats) !== amount) throw new CheckoutError(409, "Checkout amount cannot change");
    const cardUrl = String(value.cardUrl ?? "");
    let parsed: URL;
    try { parsed = new URL(cardUrl); } catch { throw new CheckoutError(400, "Invalid card URL"); }
    const match = parsed.pathname.match(/^\/card\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    const p = parsed.searchParams.get("p") ?? "", c = parsed.searchParams.get("c") ?? "";
    if (!match || !/^[0-9a-f]{32}$/i.test(p) || !/^[0-9a-f]{16}$/i.test(c)) throw new CheckoutError(400, "Invalid card URL");
    const [card] = await db.select().from(cardsTable).where(eq(cardsTable.id, match[1]));
    if (!card || card.status === "cancelled") throw new CheckoutError(400, "Card unavailable");
    const sun = decryptSunP(decrypt(card.aesKey1), p);
    if (!sun || !verifySunC(decrypt(card.aesKey2), sun.uid, sun.counter, c)) throw new CheckoutError(400, "Card authentication failed");
    if (card.uid && card.uid.toLowerCase() !== sun.uid.toString("hex")) throw new CheckoutError(400, "Card identity mismatch");
    if (row.channel) {
      if (row.channel !== "card" || row.card_id !== card.id) throw new CheckoutError(409, "Checkout already claimed by another method or card");
      return sendResponse(res, row);
    }
    if (row.state !== "ready") return sendResponse(res, row);
    const recipientWallet = await getAccountNwcUrl(card.accountId);
    if (!recipientWallet) throw new CheckoutError(400, "Card holder has no wallet configured");
    const claimed = await claimCard(k1, account.id, card.id, card.accountId);
    if (!claimed) {
      const current = await requireCheckout(k1, account.id);
      if (current.channel === "card" && current.card_id === card.id) return sendResponse(res, current);
      throw new CheckoutError(409, "Checkout already claimed by another method");
    }
    const waiting = runCheckoutWork(k1, async () => {
      let committed: Checkout | undefined;
      try {
        const invoice = await makeInvoice(amount, "openLN send from merchant", 600, recipientWallet);
        const hash = validateSendInvoice(invoice.bolt11, amount);
        committed = await commitDispatch(claimed, invoice.bolt11, hash, "card");
      } catch { await failPreparation(k1); return; }
      if (committed) await executeCommittedCheckout(committed);
    });
    return sendResponse(res, await waitForCheckout(k1, waiting));
  } catch (err) {
    if (lnurl) {
      if (err instanceof CheckoutError) return respond(res, 200, {status:"ERROR",reason:err.message,code:err.code});
      // A DB failure after a committed dispatch must not invite a wallet retry.
      return respond(res, 200, acceptedDispatch ? {status:"OK"} : {status:"ERROR",code:"SEND_UNAVAILABLE",reason:"Checkout unavailable. Check its status before retrying.",dispatched:false});
    }
    if (err instanceof CheckoutError) return respond(res, err.status, {error:err.message,code:err.code,...(validCheckoutKey(k1)?{k1}:{})});
    return respond(res, 503, {error:"Send status unavailable. Check the existing checkout before retrying.",...(validCheckoutKey(k1)?{k1}:{}),doNotRetry:true});
  }
}
