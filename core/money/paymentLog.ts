// @ts-nocheck
//
import { db, paymentEventsTable } from "@workspace/db";
import { logger } from "./logger";

export type PaymentEventStatus = "success" | "fail" | "ambiguous" | "pending" | "info";
export type PaymentEventMile = "first_mile" | "last_mile" | "both" | null;
export type PaymentEventKind = "wrap" | "send" | "receive" | "card" | "system" | "admin";

export interface RecordPaymentEventInput {
  paymentId: string;
  accountId?: string | null;
  kind: PaymentEventKind;
  event: string;
  status?: PaymentEventStatus;
  mile?: PaymentEventMile;
  message?: string | null;
  method?: string | null;
  paymentHash?: string | null;
  merchantPaymentHash?: string | null;
  amountSats?: number | null;
  feeSats?: number | null;
  durationMs?: number | null;
  detail?: Record<string, unknown> | null;
  errorClass?: string | null;
  errorMessage?: string | null;
}

/** Redact secrets from detail payloads before persistence. */
function scrub(detail: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    const key = k.toLowerCase();
    if (
      key.includes("secret") ||
      key.includes("nwc") ||
      key.includes("priv") ||
      key.includes("password") ||
      key.includes("authorization") ||
      (key.includes("preimage") && key !== "haspreimage")
    ) {
      out[k] = "[redacted]";
      continue;
    }
    if (typeof v === "string" && v.startsWith("nostr+walletconnect://")) {
      out[k] = "nostr+walletconnect://[redacted]";
      continue;
    }
    if (typeof v === "string" && v.length > 500) {
      out[k] = `${v.slice(0, 500)}…`;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function toRow(input: RecordPaymentEventInput) {
  return {
    paymentId: input.paymentId,
    accountId: input.accountId ?? null,
    kind: input.kind,
    event: input.event,
    status: input.status ?? "info",
    mile: input.mile ?? null,
    message: input.message ?? null,
    method: input.method ?? null,
    paymentHash: input.paymentHash ?? null,
    merchantPaymentHash: input.merchantPaymentHash ?? null,
    amountSats: input.amountSats ?? null,
    feeSats: input.feeSats ?? null,
    durationMs: input.durationMs ?? null,
    detail: scrub(input.detail ?? null),
    errorClass: input.errorClass ?? null,
    errorMessage: input.errorMessage ? String(input.errorMessage).slice(0, 1000) : null,
  };
}

/**
 * Fire-and-forget payment flight-recorder write.
 * Never throws to callers — money path must not fail because logging failed.
 */
export function recordPaymentEvent(input: RecordPaymentEventInput): void {
  void db
    .insert(paymentEventsTable)
    .values(toRow(input))
    .catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), paymentId: input.paymentId, event: input.event },
        "paymentLog insert failed",
      );
    });
}

/** Awaitable variant for admin actions where persistence matters. */
export async function recordPaymentEventSync(input: RecordPaymentEventInput): Promise<void> {
  try {
    await db.insert(paymentEventsTable).values(toRow(input));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), paymentId: input.paymentId, event: input.event },
      "paymentLog sync insert failed",
    );
  }
}
