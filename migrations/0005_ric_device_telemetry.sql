-- Device-scoped latest observation only. Do not store credentials or raw request bodies.
CREATE TABLE IF NOT EXISTS ric_device_telemetry (
  device_token_id uuid PRIMARY KEY REFERENCES device_tokens(id) ON DELETE CASCADE,
  firmware_version varchar(32),
  board varchar(40),
  mac varchar(17),
  partition_layout varchar(40),
  boot_id varchar(64),
  uptime_ms bigint CHECK (uptime_ms >= 0 AND uptime_ms <= 9007199254740991),
  running_partition varchar(16),
  ota_state varchar(32),
  ota_code varchar(64),
  ota_target_version varchar(32),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_hello_at timestamptz
);
