import { pgTable, text, uuid, boolean, timestamp } from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts.js";

/**
 * A saved wallet connection. An account can hold several; features (RIC,
 * Cards) and the account default point at one of them (accounts.*_connection_id).
 *
 * kind is open-ended on purpose: 'nwc' | 'blink' | 'lnaddress' today, and new
 * integration kinds (e.g. CLINK ndebit / noffer strings) can be added with
 * their own capability entry in core/money/connections.ts without a schema change.
 */
export const accountConnectionsTable = pgTable("account_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => accountsTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  // nwc only: 'veil' (managed keypair on the account) | 'custom' (stored URL)
  mode: text("mode"),
  label: text("label"),
  nwcUrlEncrypted: text("nwc_url_encrypted"),
  blinkApiKeyEncrypted: text("blink_api_key_encrypted"),
  blinkWalletId: text("blink_wallet_id"),
  blinkWalletCurrency: text("blink_wallet_currency"),
  lightningAddress: text("lightning_address"),
  lnurlVerifySupported: boolean("lnurl_verify_supported"),
  // CLINK (clinkme.dev): the static pointer string (noffer1.../ndebit1...;
  // shareable by design) and the per-connection app key used to sign/encrypt
  // requests to the wallet's node service (secret, encrypted at rest).
  clinkPointer: text("clink_pointer"),
  clinkAppKeyEncrypted: text("clink_app_key_encrypted"),
  // CLINK offer webhook (Lightning.Pub paid callback). The hook id rides in
  // the callback URL openLN hands the merchant to paste into their wallet;
  // the bearer secret is what authenticates a callback (encrypted at rest).
  // Present => the offer can be observed directly, so a wrap-unavailable
  // sale may settle through the direct fallback instead of refusing.
  clinkHookId: text("clink_hook_id"),
  clinkHookSecretEncrypted: text("clink_hook_secret_encrypted"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type AccountConnection = typeof accountConnectionsTable.$inferSelect;
