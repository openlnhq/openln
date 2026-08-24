import { pgTable, text, uuid, bigint, integer, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { accountsTable } from "./accounts";

export const cardStatusEnum = pgEnum("card_status", ["active", "frozen", "cancelled"]);

export const cardsTable = pgTable("cards", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => accountsTable.id),
  status: cardStatusEnum("status").notNull().default("active"),
  aesKey0: text("aes_key_0").notNull(),
  aesKey1: text("aes_key_1").notNull(),
  aesKey2: text("aes_key_2").notNull(),
  aesKey3: text("aes_key_3").notNull(),
  aesKey4: text("aes_key_4").notNull(),
  uid: text("uid"),
  name: text("name"),
  note: text("note"),
  counter: integer("counter").notNull().default(0),
  perTapLimitSats: bigint("per_tap_limit_sats", { mode: "number" }).notNull().default(50000),
  dailyLimitSats: bigint("daily_limit_sats", { mode: "number" }).notNull().default(500000),
  phoneVerifiedAtIssuance: boolean("phone_verified_at_issuance").notNull().default(false),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  // Per-tap k1 challenge token; set at tap-verification time, cleared after callback
  pendingK1: text("pending_k1"),
  pendingK1ExpiresAt: timestamp("pending_k1_expires_at", { withTimezone: true }),
  // One-time provisioning token - served to the Bolt Card Creator app
  provisionToken: text("provision_token"),
  provisionTokenExpiresAt: timestamp("provision_token_expires_at", { withTimezone: true }),
  // One-time wipe token - served to the Bolt Card Creator app to reset the NFC chip
  wipeToken: text("wipe_token"),
  wipeTokenExpiresAt: timestamp("wipe_token_expires_at", { withTimezone: true }),
  // LUD-21 card PIN protection
  pinHash: text("pin_hash"),
  pinLimitMsats: bigint("pin_limit_msats", { mode: "number" }),
  pinFailCount: integer("pin_fail_count").notNull().default(0),
  pinLockedAt: timestamp("pin_locked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertCardSchema = createInsertSchema(cardsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCard = z.infer<typeof insertCardSchema>;
export type Card = typeof cardsTable.$inferSelect;
