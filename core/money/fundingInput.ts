/**
 * Classify what a merchant pasted as their funding source. Shape-based, so a
 * single input field accepts every wallet:
 *
 *   - a Nostr Wallet Connect connection (nostr+walletconnect://...) - full wallet
 *   - a Blink API key (blink_...)                                   - full wallet
 *   - a Lightning Address (name@provider.com)                       - receive-only
 *     (any wallet whose address supports LUD-21 verify: Blink, Wallet of
 *     Satoshi, and others)
 *
 * Validation of the detected kind happens in the connect route, never here -
 * this helper only decides which lane to validate against.
 */
import { parseLightningAddress } from "./lnAddress.js";
import { isBlinkApiKey } from "./blink.js";

export type DetectedFunding =
  | { kind: "nwc" }
  | { kind: "blink"; apiKey: string }
  | { kind: "lnaddress"; address: string };

export function detectFunding(raw: string): DetectedFunding | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^nostr\+walletconnect:\/\//i.test(s)) return { kind: "nwc" };
  if (isBlinkApiKey(s)) return { kind: "blink", apiKey: s };
  try {
    const { user, domain } = parseLightningAddress(s);
    return { kind: "lnaddress", address: `${user}@${domain}` };
  } catch {
    return null;
  }
}
