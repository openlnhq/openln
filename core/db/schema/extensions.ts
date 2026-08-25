export * from './entities.js';
export * from './accounts.js';
export * from './transactions.js';
export * from './pendingInvoices.js';
export * from './paymentEvents.js';
export * from './cards.js';

export * from './posboxDevices.js';

export * from './partner.js';

// Per-account extension installs: enabled state + encrypted config (plugin credentials).
import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";
export const extensionInstallsTable = pgTable("extension_installs", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  extensionId: text("extension_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  configEncrypted: text("config_encrypted"),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
