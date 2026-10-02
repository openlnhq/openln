/**
 * CLINK (clinkme.dev) - Nostr-native wallet pointers from Lightning.Pub /
 * ShockWallet. Two static, shareable strings, one direction each:
 *
 *   noffer1...  RECEIVE. openLN sends a kind 21001 request over Nostr
 *               (NIP-44 encrypted) and the wallet answers with a fresh bolt11.
 *   ndebit1...  SEND. openLN hands the wallet a bolt11 over kind 21002 and
 *               the wallet's node pays it (or answers GFY with a reason).
 *
 * Requests are signed with a per-connection app key - the wallet sees one
 * stable identity ("openLN") it can approve or rate-limit. Pointer strings
 * are public; app keys are secret and live encrypted in
 * account_connections.clink_app_key_encrypted.
 *
 * Money-safety notes:
 *   - A debit is CONFIRMED by the wallet's reply: {res:'ok', preimage} where
 *     sha256(preimage) must equal the invoice's payment hash (when we could
 *     read it), or {res:'ok'} alone for an internal settlement.
 *   - A GFY reply is a DEFINITIVE rejection.
 *   - A timeout / dropped reply is AMBIGUOUS: the wallet may have paid.
 *     Callers must leave the row pending and never blind-retry (there is no
 *     lookup verb in CLINK; the wallet's own history is the authority).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ClinkSDK } from "@shocknet/clink-sdk";
import { extractPaymentHash } from "./lnAddress.js";

export type ParsedClinkPointer =
  | {
      kind: "noffer";
      raw: string;
      pubkey: string;
      relay: string;
      offer: string;
      priceType: number | null;
      price: number | null;
      currency: string | null;
    }
  | {
      kind: "ndebit";
      raw: string;
      pubkey: string;
      relay: string;
      pointerId: string | null;
      k1: string | null;
    };

export type NofferPointer = Extract<ParsedClinkPointer, { kind: "noffer" }>;
export type NdebitPointer = Extract<ParsedClinkPointer, { kind: "ndebit" }>;

/** Base CLINK failure carrying the wallet's own error code where there is one. */
export class ClinkError extends Error {
  readonly code: number | null;
  readonly latest: string | null;
  constructor(message: string, code: number | null = null, latest: string | null = null) {
    super(message);
    this.name = "ClinkError";
    this.code = code;
    this.latest = latest;
  }
}

/** The wallet definitively rejected a debit (GFY). Nothing was paid. */
export class ClinkDebitError extends ClinkError {}

/** Outcome unknown: the debit request may have reached the wallet, no reply. Never retry blind. */
export class ClinkAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClinkAmbiguousError";
  }
}

const BECH32_DATA = /^[a-z0-9]+$/;

/** Decode and sanity-check a pasted noffer1.../ndebit1... string. Null when unusable. */
export function parseClinkPointer(rawInput: string): ParsedClinkPointer | null {
  const raw = rawInput.trim().toLowerCase();
  const isNoffer = raw.startsWith("noffer1") && BECH32_DATA.test(raw.slice(7));
  const isNdebit = raw.startsWith("ndebit1") && BECH32_DATA.test(raw.slice(7));
  if (!isNoffer && !isNdebit) return null;
  try {
    const d = ClinkSDK.decodeBech32(raw);
    if (d.type === "noffer") {
      const { pubkey, relay, offer, priceType, price, currency } = d.data;
      if (!/^[0-9a-f]{64}$/.test(pubkey) || !relay) return null;
      return { kind: "noffer", raw, pubkey, relay, offer, priceType: priceType ?? null, price: price ?? null, currency: currency ?? null };
    }
    if (d.type === "ndebit") {
      const { pubkey, relay, pointer, k1 } = d.data;
      if (!/^[0-9a-f]{64}$/.test(pubkey) || !relay) return null;
      return { kind: "ndebit", raw, pubkey, relay, pointerId: pointer ?? null, k1: k1 ?? null };
    }
    return null;
  } catch {
    return null;
  }
}

export function generateClinkAppKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Offer-webhook credentials (Lightning.Pub paid callbacks). The hook id is
 * public by design - it rides in the callback URL the merchant pastes into
 * the offer's webhook form. The bearer secret is what authenticates the
 * wallet's push; its prefix keeps it distinct from RIC device tokens (bare
 * 64-hex) so it can never be mistaken for one at the server's device gate.
 */
export const CLINK_HOOK_ID_RX = /^[a-f0-9]{24}$/;
export const CLINK_HOOK_SECRET_PREFIX = "clh_";

export function generateClinkHookId(): string {
  return randomBytes(12).toString("hex");
}

export function generateClinkHookSecret(): string {
  return CLINK_HOOK_SECRET_PREFIX + randomBytes(24).toString("hex");
}

/**
 * Constant-time check of a webhook Authorization header against the stored
 * secret. Accepts "Bearer <secret>" (what Lightning.Pub sends) or a bare
 * secret value, so hand-rolled senders verify too.
 */
export function clinkHookBearerMatches(header: string | null | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  let value = header.trim();
  if (/^bearer[ \t]+/i.test(value)) value = value.replace(/^bearer[ \t]+/i, "").trim();
  const a = Buffer.from(value, "utf8");
  const b = Buffer.from(secret, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** sha256(preimage) === payment hash proves the invoice we handed over was paid. */
export function preimageMatchesHash(preimage: string, paymentHash: string): boolean {
  try {
    return createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") === paymentHash;
  } catch {
    return false;
  }
}

// ── Client seam (live SDK by default; tests inject a fake) ───────────────────

export type ClinkClient = {
  requestInvoice: (
    req: { offer: string; amountSats: number; description?: string },
    timeoutSeconds: number,
  ) => Promise<{ bolt11: string }>;
  debit: (
    req: { pointer?: string; bolt11: string; amountSats?: number; description?: string; k1?: string },
    timeoutSeconds: number,
  ) => Promise<{ res: "ok"; preimage?: string } | { res: "GFY"; code: number; error: string }>;
  stop: () => void;
};

export type ClinkClientFactory = (opts: { pubkey: string; relay: string; appKeyHex: string }) => ClinkClient;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const defaultClientFactory: ClinkClientFactory = ({ pubkey, relay, appKeyHex }) => {
  const sdk = new ClinkSDK({ privateKey: hexToBytes(appKeyHex), relays: [relay], toPubKey: pubkey });
  return {
    requestInvoice: async (req, timeoutSeconds) => {
      const r = (await sdk.Noffer(
        { offer: req.offer, amount_sats: req.amountSats, ...(req.description ? { description: req.description.slice(0, 100) } : {}) },
        undefined,
        timeoutSeconds,
      )) as { bolt11?: string; code?: number; error?: string; latest?: string };
      if (typeof r?.bolt11 === "string" && r.bolt11) return { bolt11: r.bolt11 };
      throw new ClinkError(r?.error || "the wallet rejected the invoice request", r?.code ?? null, r?.latest ?? null);
    },
    debit: async (req, timeoutSeconds) => {
      const data: { bolt11: string; pointer?: string; amount_sats?: number; k1?: string; description?: string } = { bolt11: req.bolt11 };
      if (req.pointer) data.pointer = req.pointer;
      if (typeof req.amountSats === "number") data.amount_sats = req.amountSats;
      if (req.k1) data.k1 = req.k1;
      if (req.description) data.description = req.description.slice(0, 100);
      const r = (await sdk.Ndebit(data, timeoutSeconds)) as
        | { res: "ok"; preimage?: string }
        | { res: "GFY"; code: number; error: string };
      if (r && r.res === "ok") return { res: "ok", preimage: r.preimage };
      if (r && r.res === "GFY") return { res: "GFY", code: r.code, error: r.error };
      throw new ClinkError("the wallet sent an unexpected reply to the debit request");
    },
    stop: () => {
      try {
        sdk.Stop();
      } catch {
        /* relay sockets are best-effort */
      }
    },
  };
};

let clientFactory: ClinkClientFactory | null = null;
/** Tests inject a fake CLINK wallet here (null restores the live SDK). */
export function __setClinkClientFactoryForTests(factory: ClinkClientFactory | null): void {
  clientFactory = factory;
}

function makeClient(pointer: ParsedClinkPointer, appKey: string): ClinkClient {
  return (clientFactory ?? defaultClientFactory)({ pubkey: pointer.pubkey, relay: pointer.relay, appKeyHex: appKey });
}

function withDeadline<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(onTimeout());
      }
    }, ms);
    timer.unref?.();
    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      },
    );
  });
}

export const CLINK_OFFER_TIMEOUT_MS = 20_000;
export const CLINK_DEBIT_TIMEOUT_MS = 60_000;

/**
 * Ask a noffer wallet for an invoice (receive path). Throws ClinkError on
 * any failure - no money moves here, the caller just does not get an invoice.
 */
export async function clinkRequestInvoice(opts: {
  pointer: ParsedClinkPointer;
  appKey: string;
  amountSats: number;
  description?: string;
  timeoutMs?: number;
}): Promise<{ bolt11: string; paymentHash: string }> {
  if (opts.pointer.kind !== "noffer") throw new ClinkError("not a CLINK offer pointer");
  const client = makeClient(opts.pointer, opts.appKey);
  const timeoutMs = opts.timeoutMs ?? CLINK_OFFER_TIMEOUT_MS;
  try {
    const res = await withDeadline(
      client.requestInvoice(
        { offer: opts.pointer.offer, amountSats: opts.amountSats, ...(opts.description ? { description: opts.description } : {}) },
        Math.ceil(timeoutMs / 1000),
      ),
      timeoutMs + 4_000,
      () => new ClinkError("the wallet did not answer the invoice request"),
    );
    if (!res?.bolt11 || typeof res.bolt11 !== "string") throw new ClinkError("the wallet did not return an invoice");
    let paymentHash: string;
    try {
      paymentHash = extractPaymentHash(res.bolt11);
    } catch {
      throw new ClinkError("the wallet returned an invoice openLN could not read");
    }
    return { bolt11: res.bolt11, paymentHash };
  } catch (err) {
    if (err instanceof ClinkError) throw err;
    // The SDK can reject with bare strings ("websocket error") - normalize so
    // the connect probe and invoice mints surface a readable reason.
    const raw = typeof err === "string" ? err : err instanceof Error ? err.message : "";
    if (/websocket|network error|non-101|failed to connect|econnrefused|enotfound|getaddrinfo|timed? ?out|timeout/i.test(raw)) {
      throw new ClinkError("could not reach the wallet's relay - check the wallet app is online and try again");
    }
    throw new ClinkError(raw || "the request failed");
  } finally {
    client.stop();
  }
}

/**
 * Hand a bolt11 to an ndebit wallet to pay (send path). Resolves on the
 * wallet's own confirmation. A GFY reply throws ClinkDebitError (definitive,
 * nothing moved). A missing/dropped reply throws ClinkAmbiguousError - the
 * caller must leave the transaction pending and never retry blind.
 */
export async function clinkPayInvoice(opts: {
  pointer: ParsedClinkPointer;
  appKey: string;
  bolt11: string;
  amountSats?: number;
  description?: string;
  timeoutMs?: number;
}): Promise<{ preimage: string | null }> {
  if (opts.pointer.kind !== "ndebit") throw new ClinkError("not a CLINK debit pointer");
  const client = makeClient(opts.pointer, opts.appKey);
  const timeoutMs = opts.timeoutMs ?? CLINK_DEBIT_TIMEOUT_MS;
  let res: { res: "ok"; preimage?: string } | { res: "GFY"; code: number; error: string };
  try {
    res = await withDeadline(
      client.debit(
        {
          ...(opts.pointer.pointerId ? { pointer: opts.pointer.pointerId } : {}),
          bolt11: opts.bolt11,
          ...(typeof opts.amountSats === "number" ? { amountSats: opts.amountSats } : {}),
          ...(opts.description ? { description: opts.description } : {}),
          ...(opts.pointer.k1 ? { k1: opts.pointer.k1 } : {}),
        },
        Math.ceil(timeoutMs / 1000),
      ),
      timeoutMs + 4_000,
      () => new ClinkAmbiguousError("the wallet did not answer the debit request in time"),
    );
  } catch (err) {
    // A ClinkError here means the wallet REJECTED the request outright (its
    // own error payload) - definitive, nothing was paid.
    if (err instanceof ClinkError) throw new ClinkDebitError(err.message, err.code, err.latest);
    if (err instanceof ClinkAmbiguousError) throw err;
    // Anything else (socket, relay, dropped reply) leaves the outcome unknown.
    throw new ClinkAmbiguousError(err instanceof Error ? err.message : String(err));
  } finally {
    client.stop();
  }
  if (res.res === "GFY") {
    throw new ClinkDebitError(debitErrorMessage(res.code, res.error), res.code);
  }
  return { preimage: res.preimage ?? null };
}

const OFFER_ERRORS: Record<number, string> = {
  1: "Your wallet does not recognise this offer any more - copy a fresh noffer1... from it.",
  2: "Your wallet is temporarily unavailable. Try again in a moment.",
  3: "This offer has expired or moved - copy the current noffer1... from your wallet and connect it again.",
  4: "Your wallet is rate-limiting openLN. Wait a minute and try again.",
  5: "Your wallet rejected that amount (a fixed-price offer cannot back openLN sales - use a no-price offer).",
};

const DEBIT_ERRORS: Record<number, string> = {
  1: "Your wallet denied the payment. Approve openLN in the wallet (Linked apps), then try again.",
  2: "Your wallet is temporarily unavailable. Try again in a moment.",
  3: "Your wallet marked the request as expired. Try again.",
  4: "Your wallet is rate-limiting openLN. Wait a minute and try again.",
  5: "Your wallet rejected that amount - check its spending rules and budget.",
  6: "Your wallet rejected the request. Check its linked-app settings.",
};

function debitErrorMessage(code: number, error: string): string {
  return DEBIT_ERRORS[code] ?? (error || "the wallet rejected the request");
}

/** User-facing one-liner for any CLINK failure (connect flow + logs). */
export function describeClinkError(err: unknown): string {
  if (err instanceof ClinkAmbiguousError) {
    return "Your wallet did not confirm in time. openLN will not retry automatically - check the wallet before trying again.";
  }
  if (err instanceof ClinkDebitError) {
    return DEBIT_ERRORS[err.code ?? -1] ?? `Your wallet rejected the payment (${err.message}).`;
  }
  if (err instanceof ClinkError && err.code !== null) {
    if (err.code === 3 && err.latest) {
      return "This offer has expired or moved - copy the current noffer1... from your wallet and connect it again.";
    }
    return OFFER_ERRORS[err.code] ?? `Your wallet could not complete the request (${err.message}).`;
  }
  if (err instanceof ClinkError) {
    if (/could not reach the wallet's relay/i.test(err.message)) {
      return "Could not reach your wallet's relay. Check the wallet app is online and try again.";
    }
    return `Your wallet could not complete the request (${err.message}).`;
  }
  const raw = typeof err === "string" ? err : err instanceof Error ? err.message : "";
  if (/websocket|network error|non-101|failed to connect|econnrefused|enotfound|getaddrinfo|timed? ?out|timeout/i.test(raw)) {
    return "Could not reach your wallet's relay. Check the wallet app is online and try again.";
  }
  return "The CLINK request failed.";
}

/** Update a saved connection's pointer after a wallet reports it moved (code 3 with `latest`). */
export function clinkLatestFrom(err: unknown): string | null {
  return err instanceof ClinkError && typeof err.latest === "string" && err.latest ? err.latest : null;
}

/** True when a stored pointer's relay/pubkey can even be attempted - used by health surfaces. */
export function clinkPointerLooksReachable(pointer: ParsedClinkPointer): boolean {
  return /^wss?:\/\/[^\s]+$/.test(pointer.relay) && /^[0-9a-f]{64}$/.test(pointer.pubkey);
}
