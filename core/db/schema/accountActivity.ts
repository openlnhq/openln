import { pgTable, text, uuid, timestamp } from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts.js";

// One latest-presence row per account. IP / timezone / user agent are
// operator-visibility telemetry for the admin Userbase console; they are never
// exposed on any merchant-facing surface.
export const accountActivityTable = pgTable("account_activity", {
  accountId: uuid("account_id").primaryKey().references(() => accountsTable.id, { onDelete: "cascade" }),
  lastIp: text("last_ip"),
  lastTimezone: text("last_timezone"),
  lastUserAgent: text("last_user_agent"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});
