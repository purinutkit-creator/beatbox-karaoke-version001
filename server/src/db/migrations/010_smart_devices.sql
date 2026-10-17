-- ── Smart devices (Tuya): named systems, the device of each room, automation log ──
-- trigger: MANUAL (button only) | ON_START (room clock starts / time added after it ran out) | BEFORE_END (N minutes left)
--          | AT_END (time is up → e.g. cut the power automatically) | ON_CLOSE (room closed / cancelled)
CREATE TABLE IF NOT EXISTS smart_systems (
  id serial PRIMARY KEY,
  store_id int NOT NULL DEFAULT bb_current_store() REFERENCES stores(id),
  name text NOT NULL,
  trigger text NOT NULL DEFAULT 'MANUAL' CHECK (trigger IN ('MANUAL','ON_START','BEFORE_END','AT_END','ON_CLOSE')),
  minutes int NOT NULL DEFAULT 5,
  commands jsonb NOT NULL DEFAULT '[{"code":"switch_1","value":true}]',
  show_button boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS smart_bindings (
  id serial PRIMARY KEY,
  store_id int NOT NULL DEFAULT bb_current_store() REFERENCES stores(id),
  system_id int NOT NULL REFERENCES smart_systems(id) ON DELETE CASCADE,
  room_id int NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  device_name text,
  UNIQUE (system_id, room_id)
);
CREATE TABLE IF NOT EXISTS smart_logs (
  id bigserial PRIMARY KEY,
  store_id int NOT NULL DEFAULT bb_current_store() REFERENCES stores(id),
  system_id int REFERENCES smart_systems(id) ON DELETE SET NULL,
  room_id int REFERENCES rooms(id) ON DELETE SET NULL,
  session_id int REFERENCES room_sessions(id) ON DELETE SET NULL,
  device_id text,
  name text,
  trigger text,
  ok boolean NOT NULL,
  error text,
  employee_id int REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS smart_logs_store_created_idx ON smart_logs(store_id, created_at DESC);
-- which automations already ran for a session (keyed by system + end time, so extending the time re-arms them)
ALTER TABLE room_sessions ADD COLUMN IF NOT EXISTS smart_fired jsonb NOT NULL DEFAULT '[]';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['smart_systems','smart_bindings','smart_logs'] LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(store_id)', t || '_store_idx', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS store_isolation ON %I', t);
    EXECUTE format('CREATE POLICY store_isolation ON %I USING (store_id = bb_current_store() OR bb_rls_bypass()) WITH CHECK (store_id = bb_current_store() OR bb_rls_bypass())', t);
  END LOOP;
END $$;
-- a binding / log can only point at rows of the same store
CREATE TRIGGER bb_ref_smart_bindings_system BEFORE INSERT OR UPDATE OF system_id ON smart_bindings FOR EACH ROW EXECUTE FUNCTION bb_same_store_ref('system_id', 'smart_systems', 'id');
CREATE TRIGGER bb_ref_smart_bindings_room BEFORE INSERT OR UPDATE OF room_id ON smart_bindings FOR EACH ROW EXECUTE FUNCTION bb_same_store_ref('room_id', 'rooms', 'id');

-- the Tuya credentials live with the other integrations (encrypted)
ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS integration_settings_key_check;
ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_key_check CHECK (key IN ('line','sms','slip','terminal','tuya'));
