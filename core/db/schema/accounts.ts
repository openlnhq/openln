import { pgTable, text, uuid, bigint, boolean, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { entitiesTable } from "./entities";

export const accountTypeEnum = pgEnum("account_type", ["personal", "business"]);

export const accountsTable = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityId: uuid("entity_id").notNull().references(() => entitiesTable.id),
  type: accountTypeEnum("type").notNull().default("personal"),
  businessName: text("business_name"),
  businessActive: boolean("business_active").notNull().default(false),
  currency: text("currency").notNull().default("usd"),
  rateSource: text("rate_source").notNull().default("coingecko"),
  rateModifier: text("rate_modifier"),
  // Independent modifier for sending/selling (outward payments / withdrawals).
  // When set, the device applies this instead of rateModifier in send mode.
  sendRateModifier: text("send_rate_modifier"),
  // Legacy Alby sub-wallet URL (retained for existing data, superseded by nostr keypair)
  albySubWalletNwcUrl: text("alby_sub_wallet_nwc_url"),
  // Nostr keypair for Veil NWC wallet
  nostrPrivKeyEncrypted: text("nostr_priv_key_encrypted"),
  nostrPubKey: text("nostr_pub_key"),
  // Wallet source: 'veil' (opt-in provider), 'custom' (user-supplied NWC URL),
  // 'lnaddress' (receive-only lightning address), or 'unset' (new account,
  // wallet setup not completed yet). Existing rows default to 'veil'.
  walletMode: text("wallet_mode").notNull().default("veil"),
  customNwcUrl: text("custom_nwc_url"),
  lightningAddress: text("lightning_address"),
  balanceSats: bigint("balance_sats", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertAccountSchema = createInsertSchema(accountsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type Account = typeof accountsTable.$inferSelect;
