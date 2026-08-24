import { pgTable, text, uuid, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts";

/**
 * Append-only flight recorder for money-path operations.
 * Every NWC call / wrap transition SHOULD write a row so ops can reconstruct
 * the full lifecycle of a payment without reading application logs.
 */
export const paymentEventsTable = pgTable("payment_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Groups related events for one business payment (invoice id, tx id, or generated)
  paymentId: text("payment_id").notNull(),
  accountId: uuid("account_id").references(() => accountsTable.id),
  // wrap | send | receive | card | system | admin
  kind: text("kind").notNull(),
  // e.g. wrap.created, wrap.transition, nwc.pay_invoice, nwc.get_balance, admin.action
  event: text("event").notNull(),
  // success | fail | ambiguous | pending | info
  status: text("status").notNull().default("info"),
  // first_mile (customer→hold) | last_mile (platform→merchant) | both | null
  mile: text("mile"),
  // Human-readable summary for the timeline UI
  message: text("message"),
  // nwc method or internal step name
  method: text("method"),
  paymentHash: text("payment_hash"),
  merchantPaymentHash: text("merchant_payment_hash"),
  amountSats: integer("amount_sats"),
  feeSats: integer("fee_sats"),
  durationMs: integer("duration_ms"),
  // Redacted request/response payloads (no secrets / full nwc urls)
  detail: jsonb("detail").$type<Record<string, unknown>>(),
  errorClass: text("error_class"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("payment_events_payment_id_idx").on(t.paymentId),
  index("payment_events_payment_hash_idx").on(t.paymentHash),
  index("payment_events_created_at_idx").on(t.createdAt),
  index("payment_events_account_id_idx").on(t.accountId),
  index("payment_events_status_idx").on(t.status),
  index("payment_events_kind_idx").on(t.kind),
]);

export type PaymentEvent = typeof paymentEventsTable.$inferSelect;
export type InsertPaymentEvent = typeof paymentEventsTable.$inferInsert;
