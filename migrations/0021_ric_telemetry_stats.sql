-- RIC device health telemetry (2026-10): WiFi strength and power/reboot
-- forensics reported by firmware 1.0.15+ on every hello/status post, so the
-- dashboard can distinguish a crash from a brownout from a power cycle
-- without serial access to the device.
--
-- rssi            — last observed WiFi RSSI in dBm (-127..0)
-- reset_reason    — why the current boot happened:
--                   poweron|ext|sw|panic|intwdt|taskwdt|wdt|brownout|deepsleep|sdio|unknown
-- boot_count      — boots since flash / factory reset (device NVS counter)
-- wifi_drops      — link-loss episodes since boot
-- wifi_drops_total— link-loss episodes since flash / factory reset
--
-- All nullable: devices on firmware <1.0.15 simply never report them, and a
-- status update that omits a field must not clear it (the app skips undefined
-- values on update). Idempotent: safe to re-run on every deploy.
ALTER TABLE ric_device_telemetry ADD COLUMN IF NOT EXISTS rssi integer;
ALTER TABLE ric_device_telemetry ADD COLUMN IF NOT EXISTS reset_reason varchar(32);
ALTER TABLE ric_device_telemetry ADD COLUMN IF NOT EXISTS boot_count bigint;
ALTER TABLE ric_device_telemetry ADD COLUMN IF NOT EXISTS wifi_drops bigint;
ALTER TABLE ric_device_telemetry ADD COLUMN IF NOT EXISTS wifi_drops_total bigint;
