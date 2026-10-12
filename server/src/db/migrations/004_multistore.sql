-- Multi-store (tenant) support.
-- Every business table gets store_id. Existing data belongs to the first (original) store, nothing is deleted.
-- Isolation is enforced by PostgreSQL row-level security (FORCE, so it also applies to the table owner):
-- a connection only sees rows of the store set in `app.store_id` (set per request by the server),
-- except platform maintenance code that explicitly sets `app.bypass_rls = on`.

-- ── stores: tenant record, subscription fields ──
ALTER TABLE stores ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS owner_name text;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS owner_email text;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS suspend_reason text;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Bangkok';
UPDATE stores SET slug = 'beatbox' WHERE slug IS NULL AND id = (SELECT min(id) FROM stores);
UPDATE stores SET slug = 'store-' || id WHERE slug IS NULL;
ALTER TABLE stores ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stores_slug_uq ON stores(lower(slug));
CREATE UNIQUE INDEX IF NOT EXISTS stores_owner_email_uq ON stores(lower(owner_email)) WHERE owner_email IS NOT NULL;

CREATE OR REPLACE FUNCTION bb_current_store() RETURNS int LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.store_id', true), '')::int $$;
CREATE OR REPLACE FUNCTION bb_rls_bypass() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.bypass_rls', true), '') = 'on' $$;

-- ── store_id on every business table ──
DO $$
DECLARE
  t text;
  first_store int;
  tables text[] := ARRAY[
    'branches','system_settings','counters','pos_devices','roles','role_permissions','employees','employee_permissions',
    'employee_login_logs','auth_sessions','shifts','room_types','rooms','room_packages','member_tiers','members','customers',
    'member_auth_identities','line_connections','otp_codes','member_sessions','categories','products','product_options',
    'stock_balances','stock_movements','promotions','promotion_images','rewards','reward_redemptions','reservations',
    'reservation_holds','room_sessions','room_time_adjustments','orders','order_items','payments','payment_transactions',
    'payment_verifications','deposits','deposit_refunds','refunds','receipts','point_ledgers','printers','print_jobs',
    'customer_displays','display_pairings','notifications','activity_logs','backups','integration_settings',
    'room_customer_orders','room_issues','terminal_payments'];
BEGIN
  SELECT min(id) INTO first_store FROM stores;
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS store_id int REFERENCES stores(id)', t);
    IF first_store IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I DISABLE TRIGGER USER', t);
      EXECUTE format('UPDATE %I SET store_id = %s WHERE store_id IS NULL', t, first_store);
      EXECUTE format('ALTER TABLE %I ENABLE TRIGGER USER', t);
    END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN store_id SET DEFAULT bb_current_store()', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN store_id SET NOT NULL', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(store_id)', t || '_store_idx', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS store_isolation ON %I', t);
    EXECUTE format('CREATE POLICY store_isolation ON %I USING (store_id = bb_current_store() OR bb_rls_bypass()) WITH CHECK (store_id = bb_current_store() OR bb_rls_bypass())', t);
  END LOOP;
END $$;

-- stores itself: a store only sees its own row
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS store_isolation ON stores;
CREATE POLICY store_isolation ON stores USING (id = bb_current_store() OR bb_rls_bypass()) WITH CHECK (id = bb_current_store() OR bb_rls_bypass());

-- ── numbers / codes become unique per store ──
ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS branches_store_code_uq ON branches(store_id, code);
ALTER TABLE system_settings DROP CONSTRAINT IF EXISTS system_settings_pkey;
ALTER TABLE system_settings ADD PRIMARY KEY (store_id, key);
ALTER TABLE counters DROP CONSTRAINT IF EXISTS counters_pkey;
ALTER TABLE counters ADD PRIMARY KEY (store_id, name, period);
ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS integration_settings_pkey;
ALTER TABLE integration_settings ADD PRIMARY KEY (store_id, key);
ALTER TABLE pos_devices DROP CONSTRAINT IF EXISTS pos_devices_device_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS pos_devices_store_key_uq ON pos_devices(store_id, device_key);
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS roles_store_code_uq ON roles(store_id, code);
DROP INDEX IF EXISTS employees_pin_lookup_uq;
CREATE UNIQUE INDEX IF NOT EXISTS employees_store_pin_uq ON employees(store_id, pin_lookup) WHERE deleted_at IS NULL AND pin_lookup IS NOT NULL;
ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_shift_no_key;
CREATE UNIQUE INDEX IF NOT EXISTS shifts_store_no_uq ON shifts(store_id, shift_no);
ALTER TABLE room_types DROP CONSTRAINT IF EXISTS room_types_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS room_types_store_code_uq ON room_types(store_id, code);
ALTER TABLE member_tiers DROP CONSTRAINT IF EXISTS member_tiers_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS member_tiers_store_code_uq ON member_tiers(store_id, code);
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_member_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS members_store_code_uq ON members(store_id, member_code);
DROP INDEX IF EXISTS members_phone_uq;
CREATE UNIQUE INDEX IF NOT EXISTS members_store_phone_uq ON members(store_id, phone) WHERE deleted_at IS NULL;
DROP INDEX IF EXISTS member_auth_identity_uq;
CREATE UNIQUE INDEX IF NOT EXISTS member_auth_identity_store_uq ON member_auth_identities(store_id, provider, provider_user_id) WHERE status = 'ACTIVE';
DROP INDEX IF EXISTS line_connections_active_uq;
CREATE UNIQUE INDEX IF NOT EXISTS line_connections_store_active_uq ON line_connections(store_id, line_user_id) WHERE status = 'CONNECTED';
DROP INDEX IF EXISTS products_sku_uq;
CREATE UNIQUE INDEX IF NOT EXISTS products_store_sku_uq ON products(store_id, sku) WHERE deleted_at IS NULL;
DROP INDEX IF EXISTS promotions_code_uq;
CREATE UNIQUE INDEX IF NOT EXISTS promotions_store_code_uq ON promotions(store_id, upper(code)) WHERE code IS NOT NULL AND deleted_at IS NULL;
ALTER TABLE reward_redemptions DROP CONSTRAINT IF EXISTS reward_redemptions_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS reward_redemptions_store_code_uq ON reward_redemptions(store_id, code);
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_booking_no_key;
CREATE UNIQUE INDEX IF NOT EXISTS reservations_store_no_uq ON reservations(store_id, booking_no);
ALTER TABLE room_sessions DROP CONSTRAINT IF EXISTS room_sessions_session_no_key;
CREATE UNIQUE INDEX IF NOT EXISTS room_sessions_store_no_uq ON room_sessions(store_id, session_no);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_no_key;
CREATE UNIQUE INDEX IF NOT EXISTS orders_store_no_uq ON orders(store_id, order_no);
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payment_no_key;
CREATE UNIQUE INDEX IF NOT EXISTS payments_store_no_uq ON payments(store_id, payment_no);
ALTER TABLE deposits DROP CONSTRAINT IF EXISTS deposits_deposit_no_key;
CREATE UNIQUE INDEX IF NOT EXISTS deposits_store_no_uq ON deposits(store_id, deposit_no);
ALTER TABLE deposit_refunds DROP CONSTRAINT IF EXISTS deposit_refunds_refund_no_key;
CREATE UNIQUE INDEX IF NOT EXISTS deposit_refunds_store_no_uq ON deposit_refunds(store_id, refund_no);
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_refund_no_key;
CREATE UNIQUE INDEX IF NOT EXISTS refunds_store_no_uq ON refunds(store_id, refund_no);
ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_receipt_no_key;
CREATE UNIQUE INDEX IF NOT EXISTS receipts_store_no_uq ON receipts(store_id, receipt_no);

-- the store owner signs in with email + password; Super Owner works through a hidden per-store employee
ALTER TABLE employees ALTER COLUMN pin_hash DROP NOT NULL;
ALTER TABLE employees ALTER COLUMN pin_lookup DROP NOT NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_owner boolean NOT NULL DEFAULT false;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS platform_user_id int;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS locked_until timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS employees_email_uq ON employees(lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL;

-- activity log keeps the real actor when the Super Owner works inside a store
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS platform_user_id int;
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS actor_type text NOT NULL DEFAULT 'EMPLOYEE';
