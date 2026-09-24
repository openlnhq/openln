-- Deleting a cancelled card must never be blocked by history rows, and must
-- never leave dangling references behind. The ledger and the legacy RIC
-- checkout records stay; only their reference to the removed card is cleared.
GRANT DELETE ON cards TO openln;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_card_id_fkey;
ALTER TABLE transactions ADD CONSTRAINT transactions_card_id_fkey FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE SET NULL;

-- ric_send_checkouts is legacy-era state that only exists on boxes that ran
-- the earlier RIC checkout code; alter it only where it is present.
DO $$
BEGIN
  IF to_regclass('public.ric_send_checkouts') IS NOT NULL THEN
    ALTER TABLE ric_send_checkouts DROP CONSTRAINT IF EXISTS ric_send_checkouts_card_id_fkey;
    ALTER TABLE ric_send_checkouts ADD CONSTRAINT ric_send_checkouts_card_id_fkey FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE SET NULL;
  END IF;
END $$;
