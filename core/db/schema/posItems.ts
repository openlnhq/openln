import { pgTable, text, uuid, integer, timestamp } from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts.js";

// Web POS item catalog. Price is a decimal string in the account's currency
// (same unit the merchant sees in Settings); the POS converts it to sats at
// checkout time. Photo is a small data URL thumbnail (see plugins/pos-items.ts).
export const posItemsTable = pgTable("pos_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => accountsTable.id),
  name: text("name").notNull(),
  price: text("price").notNull(),
  description: text("description"),
  photo: text("photo"),
  sort: integer("sort").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});
