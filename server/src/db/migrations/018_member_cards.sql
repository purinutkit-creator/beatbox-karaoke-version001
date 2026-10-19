-- Member cards: the card number is the member number (members.member_code). Every card given to a member is kept here:
-- ISSUED = a new random number printed by the store, SYNCED = an existing card (barcode / RFID) read at the counter and
-- made the member's number. Only one card per member is ACTIVE; the others are REPLACED (lost / changed cards stop working).
CREATE TABLE IF NOT EXISTS member_cards (
  id serial PRIMARY KEY,
  store_id int NOT NULL DEFAULT bb_current_store() REFERENCES stores(id),
  member_id int NOT NULL REFERENCES members(id),
  card_no text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ISSUED', 'SYNCED')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REPLACED')),
  previous_code text,
  print_count int NOT NULL DEFAULT 0,
  last_printed_at timestamptz,
  issued_by int REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  replaced_at timestamptz
);
CREATE INDEX IF NOT EXISTS member_cards_member_idx ON member_cards(member_id);
CREATE UNIQUE INDEX IF NOT EXISTS member_cards_one_active ON member_cards(member_id) WHERE status = 'ACTIVE';
DO $$
BEGIN
  EXECUTE 'CREATE INDEX IF NOT EXISTS member_cards_store_idx ON member_cards(store_id)';
  EXECUTE 'ALTER TABLE member_cards ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE member_cards FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS store_isolation ON member_cards';
  EXECUTE 'CREATE POLICY store_isolation ON member_cards USING (store_id = bb_current_store() OR bb_rls_bypass()) WITH CHECK (store_id = bb_current_store() OR bb_rls_bypass())';
END $$;
DROP TRIGGER IF EXISTS bb_ref_member_cards_member ON member_cards;
CREATE TRIGGER bb_ref_member_cards_member BEFORE INSERT OR UPDATE OF member_id ON member_cards FOR EACH ROW EXECUTE FUNCTION bb_same_store_ref('member_id', 'members', 'id');
DROP TRIGGER IF EXISTS bb_ref_member_cards_issued_by ON member_cards;
CREATE TRIGGER bb_ref_member_cards_issued_by BEFORE INSERT OR UPDATE OF issued_by ON member_cards FOR EACH ROW EXECUTE FUNCTION bb_same_store_ref('issued_by', 'employees', 'id');
