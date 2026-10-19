-- Floor plans: each floor of a branch has a plan (optional background picture) with the rooms drawn on it and markers
-- (entrance, stairs, lift, toilets …). Customers open a room's guide page (QR after paying) and see their room blink.
CREATE TABLE IF NOT EXISTS floors (
  id serial PRIMARY KEY,
  store_id int NOT NULL DEFAULT bb_current_store() REFERENCES stores(id),
  branch_id int REFERENCES branches(id) ON DELETE SET NULL,
  name text NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  plan_image_url text,
  aspect numeric(5,3) NOT NULL DEFAULT 1.6, -- width / height of the plan
  markers jsonb NOT NULL DEFAULT '[]',      -- [{ id, type, x, y, label }] in % of the plan
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$
BEGIN
  EXECUTE 'CREATE INDEX IF NOT EXISTS floors_store_idx ON floors(store_id)';
  EXECUTE 'ALTER TABLE floors ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE floors FORCE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS store_isolation ON floors';
  EXECUTE 'CREATE POLICY store_isolation ON floors USING (store_id = bb_current_store() OR bb_rls_bypass()) WITH CHECK (store_id = bb_current_store() OR bb_rls_bypass())';
END $$;

-- where a room is on its floor plan (% of the plan), where it is on the ground (saved by staff standing at the door),
-- and the random token of its public guide page
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS floor_id int REFERENCES floors(id) ON DELETE SET NULL;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS plan_x numeric(6,2);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS plan_y numeric(6,2);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS plan_w numeric(6,2);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS plan_h numeric(6,2);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS geo_lat double precision;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS geo_lng double precision;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS geo_accuracy numeric(7,1);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS guide_token text;
UPDATE rooms SET guide_token = replace(gen_random_uuid()::text, '-', '') WHERE guide_token IS NULL;
ALTER TABLE rooms ALTER COLUMN guide_token SET DEFAULT replace(gen_random_uuid()::text, '-', '');
CREATE UNIQUE INDEX IF NOT EXISTS rooms_guide_token_idx ON rooms(guide_token);
DROP TRIGGER IF EXISTS bb_ref_rooms_floor ON rooms;
CREATE TRIGGER bb_ref_rooms_floor BEFORE INSERT OR UPDATE OF floor_id ON rooms FOR EACH ROW EXECUTE FUNCTION bb_same_store_ref('floor_id', 'floors', 'id');
