// @ts-nocheck
/**
 * Send-target resolution for the web send scanner.
 *
 * Accepts anything a merchant might scan or paste: BOLT11 invoices, lightning
 * addresses (LUD-16), LNURL codes (bech32 lnurl1, LUD-17 lnurlp:// / lnurlw://,
 * raw https links) and BIP21 bitcoin: URIs carrying a lightning parameter.
 *
 * Never moves money: BOLT11 and LNURL-pay targets come back normalized, and an
 * LNURL-pay target with an amount also carries the provider invoice (minted via
 * the SSRF-guarded helpers in lnAddress.ts) for the client to pay through the
 * ordinary /api/wallet/pay route.
 */
import { fetchLnurlpMetadata, fetchLnurlRequest, lnurlpMetaFromBody, requestLnurlInvoiceFromMeta, type LnurlpMetadata } from "./lnAddress.js";
import { decodeLnurl, parseBolt11AmountSats } from "./boltcard.js";

export type SendTarget =
  | { kind: "bolt11"; bolt11: string; amountSats: number | null }
  | { kind: "lnurl_pay"; source: string; minSendableSats: number; maxSendableSats: number; commentAllowed: number; invoice?: { bolt11: string; paymentHash: string; amountSats: number } }
  | { kind: "lnurl_withdraw"; source: string; input: string; maxWithdrawableSats: number | null; defaultDescription: string }
  | { kind: "unsupported"; source?: string; message: string };

export type NormalizedSendInput =
  | { kind: "bolt11"; bolt11: string }
  | { kind: "lnurl"; url: string }
  | { kind: "address"; address: string }
  | { kind: "unsupported"; message: string }
  | { kind: "error"; message: string };

const ALL_CAPS = /^[A-Z0-9]+$/;

/** Map raw network failures to a merchant-friendly message; pass app errors through. */
function friendlyNet(err: unknown): Error {
  const m = err instanceof Error ? err.message : String(err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|timed out|timeout|abort|socket hang up/i.test(m)) {
    return new Error("Could not reach that payee. Check the code and try again.");
  }
  return err instanceof Error ? err : new Error(m);
}

/** Pure input classifier: trims, normalizes case/schemes, classifies. No network. */
export function normalizeSendInput(raw: string): NormalizedSendInput {
  let t = String(raw ?? "").trim();
  if (!t) return { kind: "error", message: "Nothing to read" };
  if (t.length > 2000) return { kind: "error", message: "That code is too long to read" };
  if (ALL_CAPS.test(t)) t = t.toLowerCase();
  t = t.replace(/^lightning:/i, "").trim();

  // BIP21 bitcoin: URI - take the lightning= parameter when present.
  const bip = t.match(/^bitcoin:[^\s]*?(?:\?(.*))?$/i);
  if (bip) {
    const params = new URLSearchParams(bip[1] ?? "");
    // BIP21 parameter names are case-insensitive to a lenient parser.
    const lnEntry = [...params.entries()].find(([k]) => k.toLowerCase() === "lightning");
    const ln = (lnEntry?.[1] ?? "").trim();
    if (!ln) return { kind: "unsupported", message: "That is an on-chain address, not a Lightning payment." };
    t = ALL_CAPS.test(ln) ? ln.toLowerCase() : ln;
  }

  if (/^lno1/i.test(t)) return { kind: "unsupported", message: "BOLT12 offers are not supported yet. Ask for a regular invoice." };
  if (/^ln(bc|tb|bcrt)[0-9a-z]/i.test(t)) return { kind: "bolt11", bolt11: t };
  if (/^lnurl1/i.test(t)) {
    const url = decodeLnurl(t);
    if (!url) return { kind: "unsupported", message: "This LNURL code looks damaged. Try scanning it again." };
    return { kind: "lnurl", url };
  }
  if (/^lnurlp:\/\//i.test(t)) return { kind: "lnurl", url: "https://" + t.slice(9) };
  if (/^lnurlw:\/\//i.test(t)) return { kind: "lnurl", url: "https://" + t.slice(9) };
  if (/^https:\/\//i.test(t)) return { kind: "lnurl", url: t };
  if (/^http:\/\//i.test(t)) return { kind: "unsupported", message: "Only https links can be paid from here." };
  if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(t)) return { kind: "address", address: t.toLowerCase() };
  return { kind: "unsupported", message: "This does not look like a Lightning code." };
}

/** Classify + resolve (fetches LNURL endpoints; mints the invoice when amountSats is given). */
export async function resolveSendTarget(raw: string, opts: { amountSats?: number; comment?: string } = {}): Promise<SendTarget> {
  const n = normalizeSendInput(raw);
  if (n.kind === "error") throw new Error(n.message);
  if (n.kind === "unsupported") return n;
  if (n.kind === "bolt11") {
    return { kind: "bolt11", bolt11: n.bolt11, amountSats: parseBolt11AmountSats(n.bolt11) };
  }

  let meta: LnurlpMetadata | null = null;
  let source = "";
  if (n.kind === "address") {
    source = n.address;
    meta = await fetchLnurlpMetadata(n.address).catch((e) => { throw friendlyNet(e); });
  } else {
    const url = new URL(n.url);
    source = url.hostname;
    const body = await fetchLnurlRequest(n.url).catch((e) => { throw friendlyNet(e); });
    const tag = String(body.tag ?? "");
    if (tag === "withdrawRequest") {
      const max = Number(body.maxWithdrawable);
      return {
        kind: "lnurl_withdraw",
        source,
        input: String(raw).trim(),
        maxWithdrawableSats: Number.isFinite(max) && max > 0 ? Math.floor(max / 1000) : null,
        defaultDescription: typeof body.defaultDescription === "string" ? body.defaultDescription.slice(0, 120) : "",
      };
    }
    if (tag === "login" || tag === "channelRequest") {
      return { kind: "unsupported", source, message: tag === "login" ? "This is a login code, not a payment." : "This is a channel request, not a payment." };
    }
    if (tag !== "payRequest") return { kind: "unsupported", source, message: "This link is not a Lightning payment." };
    meta = await lnurlpMetaFromBody(body);
  }

  const out: SendTarget = {
    kind: "lnurl_pay",
    source,
    minSendableSats: Math.ceil(meta.minSendableMsats / 1000),
    maxSendableSats: Math.floor(meta.maxSendableMsats / 1000),
    commentAllowed: meta.commentAllowed,
  };
  if (Number.isSafeInteger(opts.amountSats) && (opts.amountSats as number) > 0) {
    const inv = await requestLnurlInvoiceFromMeta(meta, opts.amountSats as number, opts.comment, "this payee").catch((e) => { throw friendlyNet(e); });
    out.invoice = { bolt11: inv.bolt11, paymentHash: inv.paymentHash, amountSats: opts.amountSats as number };
  }
  return out;
}
