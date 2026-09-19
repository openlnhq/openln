// Push path for hold-wraps: Alby Hub publishes NIP-47 notifications
// (hold_invoice_accepted, payment_received, payment_sent) over the relay the
// moment something happens. We subscribe once with the platform wallet and
// advance the matching wrap immediately, so the merchant forward starts
// within the same second the customer's HTLC locks, instead of on the next
// driver sweep.
//
// Facts established by probe against the live Hub (2026-09-18):
//   - notification payload is a full transaction object incl. payment_hash
//   - on (re)subscribe the relay REPLAYS recent history in a burst; handlers
//     must be idempotent (they are: advanceWrap is CAS-guarded and we only
//     touch rows that are still open in the DB)
//   - the SDK reconnects on relay close but events during the gap are lost;
//     the wrapDriver sweep remains the safety net, this is the fast path
import { NWCClient } from "@getalby/sdk";
import { PLATFORM_NWC_URL } from "./nwc.js";
import { advanceWrapNow } from "./wrapDriver.js";
import { logger } from "./logger.js";

type Notification = { notification_type: string; notification: { type?: string; state?: string; payment_hash?: string; invoice?: string } };

let client: NWCClient | undefined;
let unsubscribe: (() => void) | undefined;
let stats = { received: 0, matched: 0, lastAt: 0 };

// Coalesce: the replay burst can carry several events for one hash.
const recent = new Map<string, number>();
const COALESCE_MS = 1_500;

async function onNotification(n: Notification): Promise<void> {
  stats.received++; stats.lastAt = Date.now();
  const hash = n.notification?.payment_hash;
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return;
  // Outgoing = our merchant forward settled; incoming accepted/settled = the
  // customer's side. Both mean "look at this wrap now".
  const type = n.notification_type;
  if (!["hold_invoice_accepted", "payment_received", "payment_sent"].includes(type)) return;
  const last = recent.get(hash) ?? 0;
  if (Date.now() - last < COALESCE_MS) return;
  recent.set(hash, Date.now());
  if (recent.size > 512) recent.delete(recent.keys().next().value!);
  try {
    // For payment_sent the hash is the MERCHANT invoice hash; advanceWrapNow
    // looks up by hold hash. The driver's next sweep covers the forward
    // completion within 5 s, so we only fast-path incoming events here.
    if (type === "payment_sent") return;
    const status = await advanceWrapNow(hash, `nwc:${type}`);
    if (status) { stats.matched++; logger.info({ paymentHash: hash, type, status }, "wrap notification handled"); }
  } catch (err) {
    logger.warn({ paymentHash: hash, type, err: err instanceof Error ? err.message : String(err) }, "wrap notification handler failed");
  }
}

// A failed subscribe used to stay failed until the next process restart: one
// relay timeout at boot meant a whole day of sweep-only wraps. Now we keep
// trying with backoff (5 s .. 5 min) until subscribed, and re-arm the retry
// whenever the subscription is lost. The wrapDriver sweep covers every gap.
let retryTimer: NodeJS.Timeout | undefined;
let retryMs = 5_000;
let stopped = false;
let attempts = 0;

async function subscribeOnce(): Promise<boolean> {
  // Dedicated client: the request client in nwc.ts is evicted/recreated on
  // transient errors, which would silently drop a subscription hung on it.
  const c = new NWCClient({ nostrWalletConnectUrl: PLATFORM_NWC_URL! });
  attempts++;
  try {
    const info = await c.getInfo();
    const supported = (info as { notifications?: string[] }).notifications ?? [];
    if (!supported.includes("hold_invoice_accepted")) {
      logger.warn({ supported }, "wrap notifications: wallet does not advertise hold_invoice_accepted; driver sweep only");
    }
    const unsub = await c.subscribeNotifications((n) => void onNotification(n as Notification));
    client = c;
    unsubscribe = () => { try { unsub(); } catch { /* ignore */ } try { c.close(); } catch { /* ignore */ } unsubscribe = undefined; };
    retryMs = 5_000;
    logger.info({ supported, attempts }, "wrap notifications subscribed");
    return true;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), attempts, nextRetryMs: retryMs }, "wrap notifications: subscribe failed; driver sweep only, will retry");
    try { c.close(); } catch { /* ignore */ }
    return false;
  }
}

function scheduleRetry(): void {
  if (stopped || retryTimer) return;
  retryTimer = setTimeout(async () => {
    retryTimer = undefined;
    if (stopped || unsubscribe) return;
    const ok = await subscribeOnce();
    if (!ok) { retryMs = Math.min(retryMs * 2, 5 * 60_000); scheduleRetry(); }
  }, retryMs);
}

export async function startWrapNotifications(): Promise<() => void> {
  if (!PLATFORM_NWC_URL) { logger.warn("wrap notifications: no platform wallet configured"); return () => {}; }
  if (unsubscribe) return unsubscribe;
  stopped = false;
  const ok = await subscribeOnce();
  if (!ok) scheduleRetry();
  return () => {
    stopped = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
    unsubscribe?.();
  };
}

// Health surfaces both the live state and how hard we have been trying.
export function wrapNotificationStats() { return { ...stats, subscribed: !!unsubscribe, attempts, retryInMs: retryTimer ? retryMs : 0 }; }
