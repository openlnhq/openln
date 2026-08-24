import { pgTable, text, uuid, bigint, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { accountsTable } from "./accounts.js";

export const pendingInvoicesTable = pgTable("pending_invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => accountsTable.id),
  bolt11: text("bolt11").notNull(),
  paymentHash: text("payment_hash").notNull().unique(),
  amountSats: bigint("amount_sats", { mode: "number" }).notNull(),
  memo: text("memo"),
  nwcUrlEncrypted: text("nwc_url_encrypted"),
  cardOrderId: uuid("card_order_id"),
  // Hold-invoice wrap (1% incoming fee engine). Null wrapStatus = direct invoice.
  // bolt11 above is the customer-facing invoice (the wrapped hold invoice when wrapped);
  // merchantBolt11 is the merchant's real invoice for amount minus fee.
  merchantBolt11: text("merchant_bolt11"),
  // The merchant invoice's own payment hash. Since the platform node cannot
  // pay an invoice whose hash matches its own hold invoice (LDK keys its
  // payment store by hash - DuplicatePayment), the hold uses a platform-
  // generated preimage instead, so hold hash != merchant hash.
  merchantPaymentHash: text("merchant_payment_hash"),
  feeSats: bigint("fee_sats", { mode: "number" }),
  wrapStatus: text("wrap_status"), // created | accepted | forwarding | forwarded | settled | cancelled | needs_reconciliation
  preimage: text("preimage"),
  // Platform-generated hold preimage (hex). paymentHash = sha256(holdPreimage).
  // Persisted at creation so settlement survives any crash.
  holdPreimage: text("hold_preimage"),
  // LNURL-pay verify URL (LUD-21) for lightning-address wallet mode. When set,
  // settlement is detected by polling this URL instead of NWC lookups.
  lnurlVerifyUrl: text("lnurl_verify_url"),
  fiatCurrency: text("fiat_currency"),
  fiatAmount: text("fiat_amount"),
  fiatBaseRate: text("fiat_base_rate"),
  fiatEffectiveRate: text("fiat_effective_rate"),
  fiatModifier: text("fiat_modifier"),
  fiatRateSource: text("fiat_rate_source"),
  fiatRateDirection: text("fiat_rate_direction"),
  fiatRateAt: timestamp("fiat_rate_at", { withTimezone: true }),
  wrapUpdatedAt: timestamp("wrap_updated_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPendingInvoiceSchema = createInsertSchema(pendingInvoicesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPendingInvoice = z.infer<typeof insertPendingInvoiceSchema>;
export type PendingInvoice = typeof pendingInvoicesTable.$inferSelect;
