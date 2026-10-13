import { pgTable, text, uuid, timestamp } from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts.js";
import { accountConnectionsTable } from "./accountConnections.js";

/**
 * A Rizful one-click provisioning run. openLN creates a Rizful account for
 * the owner from scratch (browser signup, temp-mailbox verification, NWC
 * one-time-code exchange), saves the resulting wallet connection, and keeps
 * the login here so the owner can take over at rizful.com whenever they want.
 *
 * status: 'pending' (queued) | 'running' (flow in flight) | 'done' | 'error'.
 * The password and the mailbox secrets are encrypted at rest (see
 * core/money/encrypt.ts); rizful_email and lightning_address are display-only.
 */
export const rizfulProvisionsTable = pgTable("rizful_provisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => accountsTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  step: text("step"),
  error: text("error"),
  rizfulEmail: text("rizful_email"),
  rizfulPasswordEncrypted: text("rizful_password_encrypted"),
  // The wallet connection URI (encrypted) so a removed wallet can be re-linked
  // instead of creating a fresh Rizful account.
  nwcUriEncrypted: text("nwc_uri_encrypted"),
  lightningAddress: text("lightning_address"),
  mailboxAddress: text("mailbox_address"),
  mailboxPasswordEncrypted: text("mailbox_password_encrypted"),
  mailboxTokenEncrypted: text("mailbox_token_encrypted"),
  connectionId: uuid("connection_id").references(() => accountConnectionsTable.id, { onDelete: "set null" }),
  // Consent trail: when the owner accepted Rizful's terms for this run (the
  // Settings card requires the tick before a run can start).
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type RizfulProvision = typeof rizfulProvisionsTable.$inferSelect;
