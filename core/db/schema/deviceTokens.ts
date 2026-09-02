import { pgTable, varchar, uuid, timestamp } from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts.js";

export const deviceTokensTable = pgTable("device_tokens", {
  id:         uuid("id").primaryKey().defaultRandom(),
  accountId:  uuid("account_id").notNull().references(() => accountsTable.id, { onDelete: "cascade" }),
  token:      varchar("token", { length: 64 }).notNull().unique(),
  label:      varchar("label", { length: 80 }).notNull().default("RIC"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt:  timestamp("revoked_at", { withTimezone: true }),
  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DeviceToken = typeof deviceTokensTable.$inferSelect;
