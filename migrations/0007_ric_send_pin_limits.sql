-- SEND authorization throttle is distinct from login and customer card PINs.
CREATE TABLE IF NOT EXISTS ric_send_pin_attempts (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  failures integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz
);
