import { pgTable, text, uuid, bigint, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { accountsTable } from "./accounts.js";
import { cardsTable } from "./cards.js";

export const transactionDirectionEnum = pgEnum("transaction_direction", ["in", "out"]);
export const transactionTypeEnum = pgEnum("transaction_type", [
  "receive",
  "send",
  "internal_receive",
  "internal_send",
  "yield",
  "swap",
  "swap_refund",
  "fee",
]);
// Bookkeeping class. Bitcoin is money: a sale is booked at its fiat value at the
// moment of the sale, like cash, and that value never changes. Everything that
// is NOT a sale (owner top-ups, transfers to the owner's own wallet, purchases,
// refunds, fees) is classified so an accountant never taxes it as revenue.
export const transactionClassEnum = pgEnum("transaction_class", [
  "sale",
  "top_up",
  "transfer_out",
  "spend",
  "refund",
  "fee",
  "other",
]);
export type TransactionClass = (typeof transactionClassEnum.enumValues)[number];
export const TRANSACTION_CLASSES = transactionClassEnum.enumValues;

export const transactionStatusEnum = pgEnum("transaction_status", [
  "pending",
  "completed",
  "failed",
]);

export const transactionsTable = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => accountsTable.id),
  direction: transactionDirectionEnum("direction").notNull(),
  amountSats: bigint("amount_sats", { mode: "number" }).notNull(),
  feeSats: bigint("fee_sats", { mode: "number" }).notNull().default(0),
  type: transactionTypeEnum("type").notNull(),
  counterpartHandle: text("counterpart_handle"),
  counterpartLnAddress: text("counterpart_ln_address"),
  bolt11: text("bolt11"),
  paymentHash: text("payment_hash"),
  status: transactionStatusEnum("status").notNull().default("completed"),
  memo: text("memo"),
  // Set when this transaction was initiated by a Bolt Card tap
  cardId: uuid("card_id").references(() => cardsTable.id),
  // Human-readable reason stored when status is set to "failed"
  failureReason: text("failure_reason"),
  fiatCurrency: text("fiat_currency"),
  fiatAmount: text("fiat_amount"),
  fiatBaseRate: text("fiat_base_rate"),
  fiatEffectiveRate: text("fiat_effective_rate"),
  fiatModifier: text("fiat_modifier"),
  fiatRateSource: text("fiat_rate_source"),
  fiatRateDirection: text("fiat_rate_direction"),
  fiatRateAt: timestamp("fiat_rate_at", { withTimezone: true }),
  // Books (migration 0011). class is set by the code path that writes the row
  // (class_source = system) and may be corrected by the account holder
  // (class_source = user). origin says which surface produced the movement.
  class: transactionClassEnum("class"),
  classSource: text("class_source"),
  origin: text("origin"),
  note: text("note"),
  reference: text("reference"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("transactions_account_id_created_at_idx").on(table.accountId, table.createdAt),
  index("transactions_account_class_created_idx").on(table.accountId, table.class, table.createdAt),
]);

export type TransactionOrigin = "ric" | "web_pos" | "ln_address" | "wallet" | "card" | "internal" | "shop";

export const insertTransactionSchema = createInsertSchema(transactionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactionsTable.$inferSelect;
