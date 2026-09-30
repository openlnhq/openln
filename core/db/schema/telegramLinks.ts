import { pgTable, text, uuid, bigint, timestamp, index } from "drizzle-orm/pg-core";
import { entitiesTable } from "./entities.js";

// Telegram account links for the support bot (@openLN_bot). One link per
// account and one account per Telegram user. A fresh connect replaces the
// previous Telegram user on the same account (see plugins/telegram-link.ts).
export const telegramLinksTable = pgTable("telegram_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityId: uuid("entity_id").notNull().unique().references(() => entitiesTable.id, { onDelete: "cascade" }),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull().unique(),
  username: text("username"),
  firstName: text("first_name"),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// Short-lived connect codes shown in the app; single-use, 15 minutes.
export const telegramLinkCodesTable = pgTable(
  "telegram_link_codes",
  {
    code: text("code").primaryKey(),
    entityId: uuid("entity_id").notNull().references(() => entitiesTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => ({ entityIdx: index("telegram_link_codes_entity_idx").on(t.entityId) }),
);
