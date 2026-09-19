// One place that turns raw wallet / node / relay error text into something a
// cashier or merchant can act on. The raw text is preserved separately for
// the Treasury "technical reason" field; it must never reach a device screen
// or a customer-facing status. Add patterns here, not at call sites.
export type FailureClass =
  | "no_route" | "insufficient" | "expired" | "declined" | "limit" | "pin"
  | "timeout" | "connectivity" | "unknown";

export interface HumanFailure {
  class: FailureClass;
  /** Short, actionable, fits a 320 px device line. No em dashes. */
  message: string;
  /** True when trying the same payment again a moment later is reasonable. */
  retryable: boolean;
}

const RULES: Array<[RegExp, FailureClass, string, boolean]> = [
  // LND / LDK / CLN routing failures. "marked disabled by layer auto.localchans",
  // "unable to find a path", "no route", "FAILURE_REASON_NO_ROUTE", "TemporaryChannelFailure".
  [/no usable set of paths|unable to find a path|no.?route|route not found|no_route|FAILURE_REASON_NO_ROUTE|TemporaryChannelFailure|marked disabled|insufficient.*capacity|not enough.*liquidity/i,
    "no_route", "No route to destination. Try again in a moment", true],
  [/insufficient (?:balance|funds)|not enough (?:balance|funds|sats)|INSUFFICIENT_BALANCE/i,
    "insufficient", "Insufficient balance on card", false],
  [/expired|invoice.*(?:past|too old)|FAILURE_REASON_INVOICE_EXPIRED/i,
    "expired", "Invoice expired. Create a new one", false],
  [/per-tap limit|daily (?:spending )?limit|exceeds.*limit|limit (?:reached|would be exceeded)/i,
    "limit", "Card spending limit reached", false],
  [/incorrect pin|invalid pin|pin required|pin.*locked|locked after/i,
    "pin", "PIN rejected", false],
  [/frozen|cancelled card|card has been cancelled|card not found|counter replay|cmac mismatch|authentication failed/i,
    "declined", "Card declined", false],
  [/reply timeout|publish timeout|timed out|timeout|deadline exceeded|FAILURE_REASON_TIMEOUT/i,
    "timeout", "Wallet did not answer in time", true],
  [/failed to connect|econn|enotfound|websocket|relay|socket|network|unreachable/i,
    "connectivity", "Connection problem. Try again", true],
];

export function humanizeFailure(raw: unknown): HumanFailure {
  const text = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : raw ? String(raw) : "";
  for (const [re, cls, message, retryable] of RULES) {
    if (re.test(text)) return { class: cls, message, retryable };
  }
  return { class: "unknown", message: "Payment failed. Try again", retryable: true };
}

/** Strip node internals (channel ids, layer names, hex) so a raw reason can be
 * shown in an admin list row without wrapping five lines. Full text stays in
 * failure_reason for the detail view. */
export function compactTechnicalReason(raw: string | null | undefined, max = 160): string | null {
  if (!raw) return null;
  const t = raw.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}
