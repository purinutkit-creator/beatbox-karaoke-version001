-- LINE OA chat: a customer types the phone number they booked with → the booking card (confirm / cancel), then the
-- booking QR + barcode; reminders before the start; the room card when the room opens; the receipt with a "collect
-- points" button after paying.

-- the LINE user who looked the booking up in the chat (one LINE user per booking) and their confirmation
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS line_user_id text;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS customer_confirmed_at timestamptz;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS line_reminders jsonb NOT NULL DEFAULT '[]'; -- minutes-before already sent
CREATE INDEX IF NOT EXISTS reservations_line_user_idx ON reservations(line_user_id) WHERE line_user_id IS NOT NULL;

-- room card sent when the room is open, "time almost up" sent
ALTER TABLE room_sessions ADD COLUMN IF NOT EXISTS line_open_sent_at timestamptz;
ALTER TABLE room_sessions ADD COLUMN IF NOT EXISTS line_alerts jsonb NOT NULL DEFAULT '[]';

-- online receipt: a random link (the receipt number is guessable), sent to LINE, points collected later by a member
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS public_token text;
UPDATE receipts SET public_token = replace(gen_random_uuid()::text, '-', '') WHERE public_token IS NULL;
ALTER TABLE receipts ALTER COLUMN public_token SET DEFAULT replace(gen_random_uuid()::text, '-', '');
CREATE UNIQUE INDEX IF NOT EXISTS receipts_public_token_idx ON receipts(public_token);
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS line_sent_at timestamptz;
UPDATE receipts SET line_sent_at = issued_at WHERE line_sent_at IS NULL; -- receipts before this are not sent
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS points_claimed_by int REFERENCES members(id);
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS points_claimed_at timestamptz;
DROP TRIGGER IF EXISTS bb_ref_receipts_points_claimed_by ON receipts;
CREATE TRIGGER bb_ref_receipts_points_claimed_by BEFORE INSERT OR UPDATE OF points_claimed_by ON receipts FOR EACH ROW EXECUTE FUNCTION bb_same_store_ref('points_claimed_by', 'members', 'id');

-- people who talk to the store's LINE OA (phone look-ups are limited per person)
CREATE TABLE IF NOT EXISTS line_chat_users (
  id serial PRIMARY KEY,
  store_id int NOT NULL DEFAULT bb_current_store() REFERENCES stores(id),
  line_user_id text NOT NULL,
  followed boolean NOT NULL DEFAULT true,
  last_phone text,
  lookups int NOT NULL DEFAULT 0,
  lookups_since timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS line_chat_users_uq ON line_chat_users(store_id, line_user_id);
DO $$
BEGIN
  EXECUTE 'ALTER TABLE line_chat_users ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE line_chat_users FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS store_isolation ON line_chat_users';
  EXECUTE 'CREATE POLICY store_isolation ON line_chat_users USING (store_id = bb_current_store() OR bb_rls_bypass()) WITH CHECK (store_id = bb_current_store() OR bb_rls_bypass())';
END $$;

-- a LINE message being sent (two senders never send the same one)
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED'));
