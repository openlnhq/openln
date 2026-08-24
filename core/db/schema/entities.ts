import { pgTable, text, uuid, boolean, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const entitiesTable = pgTable("entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").unique(),
  handle: text("handle").notNull().unique(),
  phone: text("phone"),
  phoneVerified: boolean("phone_verified").notNull().default(false),
  pinHash: text("pin_hash").notNull(),
  passwordHash: text("password_hash"),
  // True once the account PIN is a 6-digit PIN. Legacy 4-digit accounts stay
  // false and are prompted to upgrade after login.
  pinUpgraded: boolean("pin_upgraded").notNull().default(false),
  // TOTP two-factor authentication
  totpSecret: text("totp_secret"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  // JSON array of bcrypt-hashed single-use recovery codes (consumed on use)
  totpRecoveryCodes: text("totp_recovery_codes"),
  // Verified recovery email (separate from the login email) used for account recovery
  recoveryEmail: text("recovery_email"),
  recoveryEmailVerifiedAt: timestamp("recovery_email_verified_at", { withTimezone: true }),
  // Login brute-force protection
  loginFailCount: integer("login_fail_count").notNull().default(0),
  loginLockedUntil: timestamp("login_locked_until", { withTimezone: true }),
  // System accounts (e.g. bank revenue) are identified by this flag, not by handle
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [
  index("entities_is_system_idx").on(t.isSystem),
]);

export const insertEntitySchema = createInsertSchema(entitiesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEntity = z.infer<typeof insertEntitySchema>;
export type Entity = typeof entitiesTable.$inferSelect;
