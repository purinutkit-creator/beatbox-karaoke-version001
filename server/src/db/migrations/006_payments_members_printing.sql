-- 006: pay-before-entering rooms, member phone + password login, real-paper-width printing / print queue,
--      and a database guard so a row can never reference a row of another store.
-- Only additive changes: nothing existing is removed, existing rows keep working.

-- ── cross-store reference guard ──
-- Row-level security hides other stores' rows from SELECT, but a foreign key check does not look at RLS.
-- These triggers make every reference (order → member, item → product, …) stay inside the same store.
CREATE OR REPLACE FUNCTION bb_same_store_ref() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  is_null boolean;
  ref_store int;
BEGIN
  EXECUTE format('SELECT ($1).%I IS NULL', TG_ARGV[0]) INTO is_null USING NEW;
  IF is_null THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT store_id FROM %I WHERE %I = ($1).%I', TG_ARGV[1], TG_ARGV[2], TG_ARGV[0]) INTO ref_store USING NEW;
  IF ref_store IS DISTINCT FROM NEW.store_id THEN
    RAISE EXCEPTION 'reference %.% points to another store', TG_TABLE_NAME, TG_ARGV[0] USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE
  fk record;
  trg text;
BEGIN
  FOR fk IN
    SELECT con.conname, src.relname AS src_table, a.attname AS src_col, dst.relname AS dst_table, b.attname AS dst_col
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class dst ON dst.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = src.relnamespace AND n.nspname = current_schema()
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    JOIN pg_attribute b ON b.attrelid = con.confrelid AND b.attnum = con.confkey[1]
    WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
      AND a.attname <> 'store_id'
      AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = con.conrelid AND x.attname = 'store_id' AND NOT x.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute y WHERE y.attrelid = con.confrelid AND y.attname = 'store_id' AND NOT y.attisdropped)
  LOOP
    trg := left('bb_ref_' || fk.src_table || '_' || fk.src_col, 63);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', trg, fk.src_table);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I ON %I FOR EACH ROW EXECUTE FUNCTION bb_same_store_ref(%L, %L, %L)',
                   trg, fk.src_col, fk.src_table, fk.src_col, fk.dst_table, fk.dst_col);
  END LOOP;
END $$;

-- ── rooms: pay before entering (default) or pay when closing ──
ALTER TABLE room_sessions DROP CONSTRAINT IF EXISTS room_sessions_status_check;
ALTER TABLE room_sessions ADD CONSTRAINT room_sessions_status_check
  CHECK (status IN ('PENDING_PAYMENT','SCHEDULED','ACTIVE','PAUSED','CLOSED','PAID','CANCELLED'));
DROP INDEX IF EXISTS room_sessions_one_active;
CREATE UNIQUE INDEX room_sessions_one_active ON room_sessions(room_id) WHERE status IN ('PENDING_PAYMENT','SCHEDULED','ACTIVE','PAUSED','CLOSED');
ALTER TABLE room_sessions ADD COLUMN IF NOT EXISTS payment_mode text NOT NULL DEFAULT 'POSTPAY';
ALTER TABLE room_sessions DROP CONSTRAINT IF EXISTS room_sessions_payment_mode_check;
ALTER TABLE room_sessions ADD CONSTRAINT room_sessions_payment_mode_check CHECK (payment_mode IN ('PREPAY','POSTPAY'));
ALTER TABLE room_sessions ADD COLUMN IF NOT EXISTS prepaid_amount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE room_sessions ADD COLUMN IF NOT EXISTS prepaid_at timestamptz;
ALTER TABLE room_sessions ADD COLUMN IF NOT EXISTS prepay_key text;
CREATE UNIQUE INDEX IF NOT EXISTS room_sessions_prepay_key_uq ON room_sessions(store_id, prepay_key) WHERE prepay_key IS NOT NULL;

-- the prepaid room charge is kept as money received on the same bill (deposits, source PREPAY) and deducted at checkout
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS reference text;
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS cash_received numeric(12,2);
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS change_amount numeric(12,2) NOT NULL DEFAULT 0;

-- ── members: phone + password (no OTP) ──
-- password_hash NULL = still the default password (last 4 digits of the phone); it is never stored readable.
ALTER TABLE members ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE members ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT true;
ALTER TABLE members ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
ALTER TABLE members ADD COLUMN IF NOT EXISTS password_reset_at timestamptz;
ALTER TABLE members ADD COLUMN IF NOT EXISTS password_reset_by int REFERENCES employees(id);
ALTER TABLE members ADD COLUMN IF NOT EXISTS login_failed_attempts int NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN IF NOT EXISTS login_locked_until timestamptz;
ALTER TABLE members ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
ALTER TABLE members ADD COLUMN IF NOT EXISTS extra_fields jsonb NOT NULL DEFAULT '{}';
DROP TRIGGER IF EXISTS bb_ref_members_password_reset_by ON members;
CREATE TRIGGER bb_ref_members_password_reset_by BEFORE INSERT OR UPDATE OF password_reset_by ON members FOR EACH ROW EXECUTE FUNCTION bb_same_store_ref('password_reset_by', 'employees', 'id');

-- ── printers: real paper width, printable area, margins, font size, print route ──
ALTER TABLE printers ADD COLUMN IF NOT EXISTS printable_width_mm numeric(5,1);
ALTER TABLE printers ADD COLUMN IF NOT EXISTS margin_left_mm numeric(4,1) NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS margin_right_mm numeric(4,1) NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS margin_top_mm numeric(4,1) NOT NULL DEFAULT 0;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS margin_bottom_mm numeric(4,1) NOT NULL DEFAULT 3;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS font_scale numeric(4,2) NOT NULL DEFAULT 1;
-- DRIVER = operating-system printer driver (real text + the chosen font); ESCPOS_TEXT = printer's built-in fonts only
ALTER TABLE printers ADD COLUMN IF NOT EXISTS render_mode text NOT NULL DEFAULT 'DRIVER';
ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_render_mode_check;
ALTER TABLE printers ADD CONSTRAINT printers_render_mode_check CHECK (render_mode IN ('DRIVER','ESCPOS_TEXT'));
ALTER TABLE printers ADD COLUMN IF NOT EXISTS allow_printer_font boolean NOT NULL DEFAULT false;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS escpos_codepage int;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS chars_per_line int;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS model text;
-- printers that used raster ESC/POS before are switched to the driver path: nothing is ever rasterized silently
UPDATE printers SET render_mode = 'DRIVER' WHERE render_mode IS NULL;

-- ── print jobs: document payload for reprints, ordering, copies ──
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS doc_type text;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS copies int NOT NULL DEFAULT 1;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS reprint_of bigint REFERENCES print_jobs(id);
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS device_id int REFERENCES pos_devices(id);
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS client_job_id text;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS print_jobs_client_uq ON print_jobs(store_id, client_job_id) WHERE client_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS print_jobs_store_created_idx ON print_jobs(store_id, created_at DESC);
DROP TRIGGER IF EXISTS bb_ref_print_jobs_reprint_of ON print_jobs;
CREATE TRIGGER bb_ref_print_jobs_reprint_of BEFORE INSERT OR UPDATE OF reprint_of ON print_jobs FOR EACH ROW EXECUTE FUNCTION bb_same_store_ref('reprint_of', 'print_jobs', 'id');
DROP TRIGGER IF EXISTS bb_ref_print_jobs_device_id ON print_jobs;
CREATE TRIGGER bb_ref_print_jobs_device_id BEFORE INSERT OR UPDATE OF device_id ON print_jobs FOR EACH ROW EXECUTE FUNCTION bb_same_store_ref('device_id', 'pos_devices', 'id');
