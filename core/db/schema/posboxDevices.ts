import { pgTable, text, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { accountsTable } from "./accounts.js";
export const posboxDevicesTable=pgTable("posbox_devices",{id:uuid("id").primaryKey().defaultRandom(),accountId:uuid("account_id").references(()=>accountsTable.id),mac:text("mac").notNull(),claimCode:text("claim_code"),createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp("updated_at",{withTimezone:true}).notNull().defaultNow().$onUpdate(()=>new Date())},t=>[uniqueIndex("posbox_devices_mac_idx").on(t.mac)]);
export type PosboxDevice=typeof posboxDevicesTable.$inferSelect;
