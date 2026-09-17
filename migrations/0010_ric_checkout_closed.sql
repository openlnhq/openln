-- Checkout closure is separate from payment settlement and expiry.
ALTER TABLE pending_invoices ADD COLUMN IF NOT EXISTS ric_checkout_closed_at timestamptz;
