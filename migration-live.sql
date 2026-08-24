ALTER TABLE partner_claim_codes ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days');
CREATE TABLE IF NOT EXISTS partner_audit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), partner_id uuid REFERENCES partner_accounts(id), event text NOT NULL, detail jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS partner_audit_events_created_idx ON partner_audit_events(created_at);
GRANT SELECT,INSERT,UPDATE ON partner_audit_events TO openln;
