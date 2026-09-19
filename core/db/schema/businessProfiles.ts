import { pgTable, text, uuid, integer, timestamp } from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts.js";

// Letterhead for the Books reports. One row per account; every field optional
// so a merchant can export a statement before filling anything in.
export const businessProfilesTable = pgTable("business_profiles", {
  accountId: uuid("account_id").primaryKey().references(() => accountsTable.id, { onDelete: "cascade" }),
  legalName: text("legal_name"),
  tradingName: text("trading_name"),
  taxId: text("tax_id"),
  address: text("address"),
  city: text("city"),
  country: text("country"),
  email: text("email"),
  phone: text("phone"),
  fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(1),
  reportCurrency: text("report_currency"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type BusinessProfile = typeof businessProfilesTable.$inferSelect;
