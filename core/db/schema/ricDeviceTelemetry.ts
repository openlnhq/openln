import {pgTable, uuid, varchar, bigint, timestamp} from "drizzle-orm/pg-core";
import {deviceTokensTable} from "./deviceTokens.js";

// One latest observation per issued device credential. MAC is telemetry, not identity.
export const ricDeviceTelemetryTable = pgTable("ric_device_telemetry", {
  deviceTokenId: uuid("device_token_id").primaryKey().references(() => deviceTokensTable.id, {onDelete: "cascade"}),
  firmwareVersion: varchar("firmware_version", {length: 32}),
  board: varchar("board", {length: 40}),
  mac: varchar("mac", {length: 17}),
  partitionLayout: varchar("partition_layout", {length: 40}),
  bootId: varchar("boot_id", {length: 64}),
  uptimeMs: bigint("uptime_ms", {mode: "number"}),
  runningPartition: varchar("running_partition", {length: 16}),
  otaState: varchar("ota_state", {length: 32}),
  otaCode: varchar("ota_code", {length: 64}),
  otaTargetVersion: varchar("ota_target_version", {length: 32}),
  lastSeenAt: timestamp("last_seen_at", {withTimezone: true}).notNull().defaultNow(),
  lastHelloAt: timestamp("last_hello_at", {withTimezone: true}),
});
