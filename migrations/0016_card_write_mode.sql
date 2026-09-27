-- Cards written from a phone browser over Web NFC carry no chip keys (a browser
-- cannot program NTAG424 keys). 'web' marks those cards so the tap endpoint and
-- the RIC accept their plain link taps; every pre-existing card stays on the
-- AES-SUN path ('sun'). Idempotent - applied by scripts/deploy.sh and QA setup.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS write_mode text NOT NULL DEFAULT 'sun';
