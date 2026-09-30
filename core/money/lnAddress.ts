// @ts-nocheck
//
/**
 * Lightning-address wallet mode (receive-only merchants).
 *
 * A merchant may back their openLN account with a plain lightning address
 * (name@provider) instead of an NWC wallet. POS receive then works by
 * fetching invoices from the provider via LNURL-pay (LUD-16), and settlement
 * is observed on the provider's verify URL (LUD-21) where one exists.
 * Providers without verify (Wallet of Satoshi) connect as wrapped-only: every
 * sale settles on the platform node through the wrapped hold path, which is
 * the confirmation, and the direct fallback refuses rather than mint an
 * invoice nothing could observe (policy A, 2026-09-30).
 */
import dns from "node:dns/promises";
import net from "node:net";
import { logger } from "./logger.js";

const FETCH_TIMEOUT_MS = 15_000;

// ── SSRF safety for user-supplied domains ────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return (
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80") ||
      lower.startsWith("::ffff:127.") ||
      lower.startsWith("::ffff:10.") ||
      lower.startsWith("::ffff:192.168.")
    );
  }
  return true; // not an IP - caller handles domains
}

async function assertSafeDomain(domain: string): Promise<void> {
  const lower = domain.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(lower)) {
    throw new Error(`Invalid domain in lightning address: ${domain}`);
  }
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    throw new Error("Lightning address domain not allowed");
  }
  if (net.isIP(lower)) {
    throw new Error("Lightning address domain must be a hostname, not an IP");
  }
  let addrs;
  try {
    addrs = await dns.lookup(lower, { all: true });
  } catch {
    throw new Error(`Could not resolve lightning address domain: ${domain}`);
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error("Lightning address domain resolves to a private network");
    }
  }
}

/** Ensure a provider-returned URL (callback / verify) is https on a safe host. */
async function assertSafeUrl(raw: string, what: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Provider returned an invalid ${what} URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Provider ${what} URL must be https`);
  }
  await assertSafeDomain(url.hostname);
  return url;
}

// ── bolt11 payment hash extraction ───────────────────────────────────────────
// Minimal bech32 tagged-field parse: charset decode, skip the 35-bit
// timestamp, walk tagged fields until type 1 ('p', payment_hash, 52 words).

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

export function extractPaymentHash(bolt11: string): string {
  const lower = bolt11.toLowerCase().trim();
  const sepIdx = lower.lastIndexOf("1");
  if (!lower.startsWith("ln") || sepIdx < 3) {
    throw new Error("Invalid bolt11 invoice");
  }
  const data = lower.slice(sepIdx + 1, lower.length - 6); // strip checksum
  const words: number[] = [];
  for (const ch of data) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v === -1) throw new Error("Invalid bolt11 invoice character");
    words.push(v);
  }
  let i = 7; // skip 35-bit timestamp
  while (i + 3 <= words.length) {
    const type = words[i]!;
    const len = words[i + 1]! * 32 + words[i + 2]!;
    const start = i + 3;
    if (start + len > words.length) break;
    if (type === 1 && len === 52) {
      // 52 words x 5 bits = 260 bits; the first 256 are the payment hash
      let acc = 0;
      let bits = 0;
      const bytes: number[] = [];
      for (let w = start; w < start + len && bytes.length < 32; w++) {
        acc = (acc << 5) | words[w]!;
        bits += 5;
        if (bits >= 8) {
          bits -= 8;
          bytes.push((acc >> bits) & 0xff);
        }
      }
      if (bytes.length !== 32) throw new Error("Malformed payment hash in bolt11 invoice");
      return Buffer.from(bytes).toString("hex");
    }
    i = start + len;
  }
  throw new Error("No payment hash found in bolt11 invoice");
}

// ── LNURL-pay (LUD-16) + verify (LUD-21) ─────────────────────────────────────

export interface LnurlpMetadata {
  callback: string;
  minSendableMsats: number;
  maxSendableMsats: number;
  commentAllowed: number;
}

export function parseLightningAddress(address: string): { user: string; domain: string } {
  const trimmed = address.trim().toLowerCase();
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx < 1 || atIdx === trimmed.length - 1) {
    throw new Error("Lightning address must look like name@provider.com");
  }
  const user = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);
  if (!/^[a-z0-9._+-]+$/.test(user)) {
    throw new Error("Lightning address name contains invalid characters");
  }
  return { user, domain };
}

export async function fetchLnurlpMetadata(address: string): Promise<LnurlpMetadata> {
  const { user, domain } = parseLightningAddress(address);
  await assertSafeDomain(domain);

  const wellKnownUrl = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}`;
  const resp = await fetch(wellKnownUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  if (!resp.ok) {
    throw new Error(`Provider does not recognize this lightning address (${resp.status})`);
  }
  const meta = await resp.json() as Record<string, unknown>;
  return lnurlpMetaFromBody(meta, "Address");
}

/** Build payRequest metadata from a response body; the callback is safety-checked. */
export async function lnurlpMetaFromBody(meta: Record<string, unknown>, what = "Endpoint"): Promise<LnurlpMetadata> {
  if (meta.status === "ERROR") throw new Error(`Provider error: ${meta.reason}`);
  if (meta.tag !== "payRequest") throw new Error(`${what} did not return a valid LNURL-pay response`);

  const callback = String(meta.callback ?? "");
  if (!callback) throw new Error("Provider returned no callback URL");
  await assertSafeUrl(callback, "callback");

  return {
    callback,
    minSendableMsats: Number(meta.minSendable ?? 1000),
    maxSendableMsats: Number(meta.maxSendable ?? 100_000_000_000),
    commentAllowed: Number(meta.commentAllowed ?? 0),
  };
}

/**
 * Fetch any LNURL endpoint by URL (SSRF-guarded); returns the parsed body.
 * Used by the send scanner for raw https links and decoded lnurl1 codes.
 */
export async function fetchLnurlRequest(raw: string): Promise<Record<string, unknown>> {
  const url = await assertSafeUrl(raw, "LNURL");
  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  if (!resp.ok) throw new Error(`Provider did not answer (${resp.status})`);
  const data = await resp.json() as Record<string, unknown>;
  if (data.status === "ERROR") throw new Error(`Provider error: ${data.reason ?? "unknown"}`);
  return data;
}

export interface LnurlInvoice {
  bolt11: string;
  paymentHash: string;
  verifyUrl: string | null;
}

/**
 * Request an invoice for `amountSats` from the address's LNURL-pay callback.
 * Returns the bolt11, its payment hash, and the LUD-21 verify URL (null if
 * the provider does not support verify).
 */
export async function requestLnurlInvoice(
  address: string,
  amountSats: number,
  memo?: string,
): Promise<LnurlInvoice> {
  const meta = await fetchLnurlpMetadata(address);
  return requestLnurlInvoiceFromMeta(meta, amountSats, memo, "this address");
}

/**
 * Request an invoice for `amountSats` from already-fetched payRequest metadata.
 * `what` names the payee in out-of-range errors (address or scanned link).
 */
export async function requestLnurlInvoiceFromMeta(
  meta: LnurlpMetadata,
  amountSats: number,
  memo?: string,
  what = "this payee",
): Promise<LnurlInvoice> {
  const amountMsats = amountSats * 1000;
  if (amountMsats < meta.minSendableMsats || amountMsats > meta.maxSendableMsats) {
    throw new Error(
      `Amount out of range for ${what} (min ${Math.ceil(meta.minSendableMsats / 1000)} sats, max ${Math.floor(meta.maxSendableMsats / 1000)} sats)`,
    );
  }

  const sep = meta.callback.includes("?") ? "&" : "?";
  let invoiceUrl = `${meta.callback}${sep}amount=${amountMsats}`;
  if (memo && meta.commentAllowed > 0) {
    invoiceUrl += `&comment=${encodeURIComponent(memo.slice(0, meta.commentAllowed))}`;
  }

  const resp = await fetch(invoiceUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  if (!resp.ok) throw new Error(`Provider invoice request failed (${resp.status})`);
  const data = await resp.json() as Record<string, unknown>;
  if (data.status === "ERROR") throw new Error(`Provider invoice error: ${data.reason}`);
  // Some providers (e.g. getalby) report failures as {error:true, message:"..."}.
  if (data.error && typeof data.message === "string") throw new Error(String(data.message).slice(0, 200));

  const bolt11 = String(data.pr ?? "");
  if (!bolt11) throw new Error("Provider returned no invoice");
  const paymentHash = extractPaymentHash(bolt11);

  let verifyUrl: string | null = null;
  if (typeof data.verify === "string" && data.verify) {
    try {
      await assertSafeUrl(data.verify, "verify");
      verifyUrl = data.verify;
    } catch (err) {
      logger.warn({ err }, "Provider verify URL rejected as unsafe");
    }
  }

  return { bolt11, paymentHash, verifyUrl };
}

/**
 * Validate a lightning address for use as a wallet source: the address must
 * resolve and hand out invoices (a real probe invoice). Returns whether the
 * provider serves a LUD-21 `verify` URL: with verify, a direct fallback
 * invoice can still be confirmed from the provider's side; without it
 * (Wallet of Satoshi) the account is wrapped-only and the direct fallback
 * refuses. Throws with a user-facing message when the address is unusable.
 */
export interface LnAddressWalletCheck {
  verifySupported: boolean;
}
export async function validateLightningAddressForWallet(address: string): Promise<LnAddressWalletCheck> {
  const meta = await fetchLnurlpMetadata(address);
  const testSats = Math.max(1, Math.ceil(meta.minSendableMsats / 1000));
  const invoice = await requestLnurlInvoice(address, testSats);
  return { verifySupported: Boolean(invoice.verifyUrl) };
}

export interface LnurlVerifyResult {
  settled: boolean;
  preimage?: string;
}

/** Poll a LUD-21 verify URL. Throws on transport errors; callers treat those as "still pending". */
export async function checkLnurlVerify(verifyUrl: string): Promise<LnurlVerifyResult> {
  const resp = await fetch(verifyUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  if (!resp.ok) throw new Error(`Verify request failed (${resp.status})`);
  const data = await resp.json() as Record<string, unknown>;
  if (data.status === "ERROR") throw new Error(`Verify error: ${data.reason}`);
  return {
    settled: data.settled === true,
    preimage: typeof data.preimage === "string" && data.preimage ? data.preimage : undefined,
  };
}
