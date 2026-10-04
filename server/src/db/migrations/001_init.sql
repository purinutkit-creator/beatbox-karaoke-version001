-- BEATBOX Karaoke POS — initial schema
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ───────────────────────── Store / system ─────────────────────────
CREATE TABLE stores (
  id serial PRIMARY KEY,
  name text NOT NULL,
  logo_url text,
  address text,
  phone text,
  tax_id text,
  slogan text,
  currency text NOT NULL DEFAULT 'THB',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id serial PRIMARY KEY,
  store_id int NOT NULL REFERENCES stores(id),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  address text,
  phone text,
  open_time time NOT NULL DEFAULT '12:00',
  close_time time NOT NULL DEFAULT '02:00',
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by int
);

CREATE TABLE counters (
  name text NOT NULL,
  period text NOT NULL DEFAULT 'ALL',
  value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, period)
);

CREATE TABLE pos_devices (
  id serial PRIMARY KEY,
  branch_id int REFERENCES branches(id),
  name text NOT NULL,
  device_key text NOT NULL UNIQUE,
  display_code text UNIQUE,
  last_seen_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Employees & permissions ─────────────────────────
CREATE TABLE roles (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE permissions (
  code text PRIMARY KEY,
  name text NOT NULL,
  group_name text
);

CREATE TABLE role_permissions (
  role_id int NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE employees (
  id serial PRIMARY KEY,
  name text NOT NULL,
  pin_hash text NOT NULL,          -- bcrypt hash of the 4-digit code
  pin_lookup text NOT NULL,        -- HMAC-SHA256(pin, server secret) for lookup & uniqueness
  photo_url text,
  position text,
  phone text,
  role_id int NOT NULL REFERENCES roles(id),
  discount_limit_percent numeric(5,2) NOT NULL DEFAULT 10,
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  failed_attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX employees_pin_lookup_uq ON employees(pin_lookup) WHERE deleted_at IS NULL;

CREATE TABLE employee_permissions (
  employee_id int NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  granted boolean NOT NULL,
  PRIMARY KEY (employee_id, permission_code)
);

CREATE TABLE employee_login_logs (
  id bigserial PRIMARY KEY,
  employee_id int REFERENCES employees(id),
  device_id int REFERENCES pos_devices(id),
  success boolean NOT NULL,
  ip text,
  user_agent text,
  action text NOT NULL DEFAULT 'LOGIN',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id int NOT NULL REFERENCES employees(id),
  device_id int REFERENCES pos_devices(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- ───────────────────────── Shifts ─────────────────────────
CREATE TABLE shifts (
  id serial PRIMARY KEY,
  shift_no text NOT NULL UNIQUE,
  branch_id int REFERENCES branches(id),
  device_id int REFERENCES pos_devices(id),
  employee_id int NOT NULL REFERENCES employees(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  opening_cash numeric(12,2) NOT NULL DEFAULT 0,
  open_note text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  closed_at timestamptz,
  closed_by int REFERENCES employees(id),
  expected_cash numeric(12,2),
  counted_cash numeric(12,2),
  difference numeric(12,2),
  close_note text,
  summary jsonb
);
CREATE UNIQUE INDEX shifts_one_open_per_device ON shifts(device_id) WHERE status = 'OPEN';

-- ───────────────────────── Rooms ─────────────────────────
CREATE TABLE room_types (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  image_url text,
  description text,
  capacity int NOT NULL DEFAULT 6,
  price_hour numeric(12,2) NOT NULL DEFAULT 0,
  price_half numeric(12,2) NOT NULL DEFAULT 0,
  half_price_manual boolean NOT NULL DEFAULT false,
  default_deposit numeric(12,2) NOT NULL DEFAULT 0,
  color text NOT NULL DEFAULT '#7c3aed',
  amenities text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE rooms (
  id serial PRIMARY KEY,
  branch_id int NOT NULL REFERENCES branches(id),
  room_type_id int NOT NULL REFERENCES room_types(id),
  name text NOT NULL,
  number text NOT NULL,
  image_url text,
  zone text,
  capacity int NOT NULL DEFAULT 6,
  price_hour numeric(12,2) NOT NULL DEFAULT 0,
  price_half numeric(12,2) NOT NULL DEFAULT 0,
  half_price_manual boolean NOT NULL DEFAULT false,
  deposit numeric(12,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'AVAILABLE',
  note text,
  sort_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX rooms_number_uq ON rooms(branch_id, number) WHERE deleted_at IS NULL;

CREATE TABLE room_packages (
  id serial PRIMARY KEY,
  name text NOT NULL,
  room_type_ids int[] NOT NULL DEFAULT '{}',
  hours int NOT NULL DEFAULT 0,
  minutes int NOT NULL DEFAULT 0,
  price numeric(12,2) NOT NULL DEFAULT 0,
  included_guests int,
  image_url text,
  description text,
  available_days int[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  available_from time,
  available_to time,
  blackout_dates date[] NOT NULL DEFAULT '{}',
  deposit numeric(12,2),
  member_only boolean NOT NULL DEFAULT false,
  is_online boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- ───────────────────────── Members ─────────────────────────
CREATE TABLE member_tiers (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#9ca3af',
  sort_order int NOT NULL DEFAULT 0,
  min_points numeric(12,2),
  min_spending numeric(12,2),
  min_visits int,
  min_hours numeric(10,2),
  condition_mode text NOT NULL DEFAULT 'ANY' CHECK (condition_mode IN ('ANY','ALL')),
  point_multiplier numeric(6,2) NOT NULL DEFAULT 1,
  room_discount_percent numeric(5,2) NOT NULL DEFAULT 0,
  product_discount_percent numeric(5,2) NOT NULL DEFAULT 0,
  benefits jsonb NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE members (
  id serial PRIMARY KEY,
  member_code text NOT NULL UNIQUE,
  first_name text NOT NULL,
  last_name text,
  nickname text,
  phone text NOT NULL,
  birthday date,
  gender text,
  email text,
  photo_url text,
  tier_id int REFERENCES member_tiers(id),
  points_balance numeric(12,2) NOT NULL DEFAULT 0,   -- cache, only maintained through point_ledgers
  total_spending numeric(14,2) NOT NULL DEFAULT 0,
  visit_count int NOT NULL DEFAULT 0,
  total_minutes int NOT NULL DEFAULT 0,
  favorite_items text,
  note text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','BANNED')),
  source text NOT NULL DEFAULT 'POS',
  marketing_consent boolean NOT NULL DEFAULT false,
  created_by int REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX members_phone_uq ON members(phone) WHERE deleted_at IS NULL;

CREATE TABLE customers (
  id serial PRIMARY KEY,
  name text,
  phone text,
  member_id int REFERENCES members(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE member_auth_identities (
  id serial PRIMARY KEY,
  member_id int NOT NULL REFERENCES members(id),
  provider text NOT NULL CHECK (provider IN ('PHONE','LINE')),
  provider_user_id text NOT NULL,
  display_name text,
  picture_url text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISCONNECTED')),
  linked_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  disconnected_at timestamptz
);
CREATE UNIQUE INDEX member_auth_identity_uq ON member_auth_identities(provider, provider_user_id) WHERE status = 'ACTIVE';

CREATE TABLE line_connections (
  id serial PRIMARY KEY,
  member_id int NOT NULL REFERENCES members(id),
  line_user_id text NOT NULL,
  display_name text,
  picture_url text,
  messaging_consent boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'CONNECTED' CHECK (status IN ('CONNECTED','DISCONNECTED')),
  linked_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  disconnected_at timestamptz
);
CREATE UNIQUE INDEX line_connections_active_uq ON line_connections(line_user_id) WHERE status = 'CONNECTED';

CREATE TABLE otp_codes (
  id bigserial PRIMARY KEY,
  phone text NOT NULL,
  purpose text NOT NULL,
  code_hash text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE member_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id int NOT NULL REFERENCES members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

-- ───────────────────────── Products ─────────────────────────
CREATE TABLE categories (
  id serial PRIMARY KEY,
  name text NOT NULL,
  icon text,
  color text NOT NULL DEFAULT '#7c3aed',
  station text NOT NULL DEFAULT 'NONE' CHECK (station IN ('NONE','KITCHEN','BAR','PREP')),
  printer_id int,
  sort_order int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE products (
  id serial PRIMARY KEY,
  sku text NOT NULL,
  barcode text,
  name text NOT NULL,
  image_url text,
  category_id int REFERENCES categories(id),
  description text,
  price numeric(12,2) NOT NULL DEFAULT 0,
  cost numeric(12,2) NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'ชิ้น',
  track_stock boolean NOT NULL DEFAULT true,
  min_stock numeric(12,2) NOT NULL DEFAULT 0,
  is_available boolean NOT NULL DEFAULT true,
  is_sold_out boolean NOT NULL DEFAULT false,
  sc_exempt boolean NOT NULL DEFAULT false,
  points_eligible boolean NOT NULL DEFAULT true,
  note text,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX products_sku_uq ON products(sku) WHERE deleted_at IS NULL;
CREATE INDEX products_barcode_idx ON products(barcode);

CREATE TABLE product_options (
  id serial PRIMARY KEY,
  product_id int NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  group_name text NOT NULL DEFAULT 'ตัวเลือก',
  name text NOT NULL,
  price_delta numeric(12,2) NOT NULL DEFAULT 0,
  is_addon boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0
);

CREATE TABLE stock_balances (
  product_id int PRIMARY KEY REFERENCES products(id),
  quantity numeric(12,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stock_movements (
  id bigserial PRIMARY KEY,
  product_id int NOT NULL REFERENCES products(id),
  type text NOT NULL,
  quantity numeric(12,2) NOT NULL,
  balance_after numeric(12,2) NOT NULL,
  unit_cost numeric(12,2),
  reference text,
  order_id int,
  employee_id int REFERENCES employees(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_product_idx ON stock_movements(product_id, created_at DESC);

-- ───────────────────────── Promotions ─────────────────────────
CREATE TABLE promotions (
  id serial PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL,
  value_type text NOT NULL DEFAULT 'AMOUNT' CHECK (value_type IN ('AMOUNT','PERCENT')),
  value numeric(12,2) NOT NULL DEFAULT 0,
  code text,
  conditions jsonb NOT NULL DEFAULT '{}',
  image_url text,
  description text,
  start_date date,
  end_date date,
  usage_limit int,
  used_count int NOT NULL DEFAULT 0,
  auto_apply boolean NOT NULL DEFAULT false,
  is_online boolean NOT NULL DEFAULT true,
  deposit_amount numeric(12,2),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX promotions_code_uq ON promotions(upper(code)) WHERE code IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE promotion_images (
  id serial PRIMARY KEY,
  title text,
  image_url text NOT NULL,
  link_url text,
  duration_seconds int NOT NULL DEFAULT 8,
  sort_order int NOT NULL DEFAULT 0,
  show_on_display boolean NOT NULL DEFAULT true,
  show_on_website boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Rewards / points ─────────────────────────
CREATE TABLE rewards (
  id serial PRIMARY KEY,
  name text NOT NULL,
  image_url text,
  description text,
  points_cost int NOT NULL,
  reward_type text NOT NULL,
  value numeric(12,2) NOT NULL DEFAULT 0,
  product_id int REFERENCES products(id),
  room_type_ids int[] NOT NULL DEFAULT '{}',
  available_days int[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  available_from time,
  available_to time,
  expires_at date,
  valid_days int NOT NULL DEFAULT 30,
  quantity_total int,
  quantity_used int NOT NULL DEFAULT 0,
  limit_per_member int,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE reward_redemptions (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  reward_id int NOT NULL REFERENCES rewards(id),
  member_id int NOT NULL REFERENCES members(id),
  points int NOT NULL,
  status text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','USED','CANCELLED','EXPIRED')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  used_at timestamptz,
  used_order_id int,
  employee_id int REFERENCES employees(id),
  idempotency_key text UNIQUE
);

-- ───────────────────────── Reservations ─────────────────────────
CREATE TABLE reservations (
  id serial PRIMARY KEY,
  booking_no text NOT NULL UNIQUE,
  branch_id int NOT NULL REFERENCES branches(id),
  room_id int NOT NULL REFERENCES rooms(id),
  room_type_id int NOT NULL REFERENCES room_types(id),
  member_id int REFERENCES members(id),
  customer_name text NOT NULL,
  phone text NOT NULL,
  guest_count int NOT NULL DEFAULT 1,
  package_id int REFERENCES room_packages(id),
  promotion_id int REFERENCES promotions(id),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  duration_minutes int NOT NULL,
  estimated_total numeric(12,2) NOT NULL DEFAULT 0,
  estimate_snapshot jsonb,
  deposit_required numeric(12,2) NOT NULL DEFAULT 0,
  deposit_paid numeric(12,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'PENDING',
  source text NOT NULL DEFAULT 'POS',
  note text,
  check_in_token text NOT NULL UNIQUE,
  hold_expires_at timestamptz,
  checked_in_at timestamptz,
  session_id int,
  created_by int REFERENCES employees(id),
  cancelled_at timestamptz,
  cancel_reason text,
  no_show_notified_at timestamptz,
  reminder_sent_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  -- Database-level double booking protection
  CONSTRAINT reservations_no_overlap EXCLUDE USING gist (
    room_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status IN ('HOLD','PENDING','CONFIRMED','DEPOSIT_PAID','WAITING','ARRIVED','IN_USE'))
);
CREATE INDEX reservations_phone_idx ON reservations(phone);
CREATE INDEX reservations_start_idx ON reservations(start_at);

CREATE TABLE reservation_holds (
  id serial PRIMARY KEY,
  reservation_id int NOT NULL REFERENCES reservations(id),
  hold_token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Room sessions ─────────────────────────
CREATE TABLE room_sessions (
  id serial PRIMARY KEY,
  session_no text NOT NULL UNIQUE,
  room_id int NOT NULL REFERENCES rooms(id),
  room_type_id int NOT NULL REFERENCES room_types(id),
  reservation_id int REFERENCES reservations(id),
  member_id int REFERENCES members(id),
  customer_name text,
  phone text,
  guest_count int NOT NULL DEFAULT 1,
  room_capacity int NOT NULL DEFAULT 0,
  package_id int REFERENCES room_packages(id),
  package_name text,
  package_minutes int NOT NULL DEFAULT 0,
  package_price numeric(12,2) NOT NULL DEFAULT 0,
  booked_minutes int NOT NULL DEFAULT 0,
  extension_minutes int NOT NULL DEFAULT 0,
  price_hour numeric(12,2) NOT NULL,
  price_half numeric(12,2) NOT NULL,
  extra_guest_fee numeric(12,2) NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL,
  scheduled_end_at timestamptz NOT NULL,
  paused_at timestamptz,
  total_paused_seconds int NOT NULL DEFAULT 0,
  ended_at timestamptz,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('SCHEDULED','ACTIVE','PAUSED','CLOSED','PAID','CANCELLED')),
  alerts_sent jsonb NOT NULL DEFAULT '[]',
  order_id int,
  opened_by int REFERENCES employees(id),
  closed_by int REFERENCES employees(id),
  cancel_reason text,
  client_op_id text UNIQUE,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- A room can only have one running session at a time (protects against concurrent opens from many devices)
CREATE UNIQUE INDEX room_sessions_one_active ON room_sessions(room_id) WHERE status IN ('SCHEDULED','ACTIVE','PAUSED','CLOSED');

CREATE TABLE room_time_adjustments (
  id serial PRIMARY KEY,
  session_id int NOT NULL REFERENCES room_sessions(id),
  type text NOT NULL,
  minutes int,
  before jsonb,
  after jsonb,
  reason text,
  employee_id int REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Orders ─────────────────────────
CREATE TABLE orders (
  id serial PRIMARY KEY,
  order_no text NOT NULL UNIQUE,
  branch_id int REFERENCES branches(id),
  session_id int REFERENCES room_sessions(id),
  reservation_id int REFERENCES reservations(id),
  member_id int REFERENCES members(id),
  customer_name text,
  phone text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PAID','VOID','REFUNDED','PARTIALLY_REFUNDED')),
  bill_discount_type text,
  bill_discount_value numeric(12,2) NOT NULL DEFAULT 0,
  bill_discount_reason text,
  promotion_ids int[] NOT NULL DEFAULT '{}',
  promo_code text,
  redemption_ids int[] NOT NULL DEFAULT '{}',
  discount_approved_by int REFERENCES employees(id),
  settings_snapshot jsonb,
  calc_snapshot jsonb,
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  discount_total numeric(12,2) NOT NULL DEFAULT 0,
  service_charge numeric(12,2) NOT NULL DEFAULT 0,
  vat numeric(12,2) NOT NULL DEFAULT 0,
  rounding numeric(12,2) NOT NULL DEFAULT 0,
  grand_total numeric(12,2) NOT NULL DEFAULT 0,
  room_total numeric(12,2) NOT NULL DEFAULT 0,
  product_total numeric(12,2) NOT NULL DEFAULT 0,
  deposit_applied numeric(12,2) NOT NULL DEFAULT 0,
  points_used int NOT NULL DEFAULT 0,
  net_total numeric(12,2) NOT NULL DEFAULT 0,
  paid_total numeric(12,2) NOT NULL DEFAULT 0,
  change_amount numeric(12,2) NOT NULL DEFAULT 0,
  refunded_total numeric(12,2) NOT NULL DEFAULT 0,
  points_earned int NOT NULL DEFAULT 0,
  billed_minutes int NOT NULL DEFAULT 0,
  guest_count int,
  extra_guests int NOT NULL DEFAULT 0,
  queue_no text,
  shift_id int REFERENCES shifts(id),
  device_id int REFERENCES pos_devices(id),
  created_by int REFERENCES employees(id),
  paid_by int REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  voided_at timestamptz,
  voided_by int REFERENCES employees(id),
  void_reason text,
  client_op_id text UNIQUE,
  version int NOT NULL DEFAULT 1
);
CREATE INDEX orders_paid_at_idx ON orders(paid_at);
CREATE UNIQUE INDEX orders_one_open_per_session ON orders(session_id) WHERE status = 'OPEN' AND session_id IS NOT NULL;

CREATE TABLE order_items (
  id serial PRIMARY KEY,
  order_id int NOT NULL REFERENCES orders(id),
  item_type text NOT NULL,
  product_id int REFERENCES products(id),
  category_id int REFERENCES categories(id),
  name text NOT NULL,
  qty numeric(12,2) NOT NULL DEFAULT 1,
  unit_price numeric(12,2) NOT NULL DEFAULT 0,
  unit_cost numeric(12,2) NOT NULL DEFAULT 0,
  options jsonb NOT NULL DEFAULT '[]',
  note text,
  discount_type text,
  discount_value numeric(12,2) NOT NULL DEFAULT 0,
  sc_exempt boolean NOT NULL DEFAULT false,
  points_eligible boolean NOT NULL DEFAULT true,
  station text NOT NULL DEFAULT 'NONE',
  kitchen_status text NOT NULL DEFAULT 'NONE',
  sent_at timestamptz,
  meta jsonb NOT NULL DEFAULT '{}',
  is_system boolean NOT NULL DEFAULT false,
  created_by int REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by int REFERENCES employees(id),
  void_reason text,
  refunded_qty numeric(12,2) NOT NULL DEFAULT 0,
  client_op_id text UNIQUE
);
CREATE INDEX order_items_order_idx ON order_items(order_id);

-- ───────────────────────── Payments ─────────────────────────
CREATE TABLE payments (
  id serial PRIMARY KEY,
  payment_no text NOT NULL UNIQUE,
  purpose text NOT NULL DEFAULT 'SALE' CHECK (purpose IN ('SALE','DEPOSIT')),
  order_id int REFERENCES orders(id),
  reservation_id int REFERENCES reservations(id),
  deposit_id int,
  method text NOT NULL,
  amount numeric(12,2) NOT NULL,
  received numeric(12,2),
  change_amount numeric(12,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'PAID' CHECK (status IN ('PENDING','VERIFYING','PAID','FAILED','CANCELLED','REFUNDED','PARTIALLY_REFUNDED')),
  reference text,
  slip_url text,
  verified_by int REFERENCES employees(id),
  verified_at timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  shift_id int REFERENCES shifts(id),
  employee_id int REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

CREATE TABLE payment_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id int REFERENCES reservations(id),
  order_id int REFERENCES orders(id),
  member_id int REFERENCES members(id),
  purpose text NOT NULL DEFAULT 'DEPOSIT',
  provider text NOT NULL,
  method text NOT NULL,
  amount numeric(12,2) NOT NULL,
  currency text NOT NULL DEFAULT 'THB',
  reference text,
  qr_data text,
  qr_image_url text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','VERIFYING','PAID','FAILED','EXPIRED','CANCELLED','REFUNDED','PARTIALLY_REFUNDED','MANUAL_REVIEW')),
  idempotency_key text UNIQUE,
  provider_reference text,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  paid_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_verifications (
  id serial PRIMARY KEY,
  payment_transaction_id uuid REFERENCES payment_transactions(id),
  reservation_id int REFERENCES reservations(id),
  provider text NOT NULL,
  transaction_ref text,
  amount numeric(12,2),
  slip_path text,
  slip_hash text,
  result text NOT NULL DEFAULT 'PENDING' CHECK (result IN ('PENDING','PASSED','FAILED','MANUAL_REVIEW')),
  failure_reason text,
  raw_provider_ref jsonb,
  reviewed_by int REFERENCES employees(id),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A verified slip / transaction reference can never be reused for another payment
CREATE UNIQUE INDEX payment_verifications_ref_uq ON payment_verifications(transaction_ref) WHERE result = 'PASSED' AND transaction_ref IS NOT NULL;
CREATE UNIQUE INDEX payment_verifications_hash_uq ON payment_verifications(slip_hash) WHERE result = 'PASSED' AND slip_hash IS NOT NULL;

CREATE TABLE deposits (
  id serial PRIMARY KEY,
  deposit_no text NOT NULL UNIQUE,
  reservation_id int REFERENCES reservations(id),
  session_id int REFERENCES room_sessions(id),
  member_id int REFERENCES members(id),
  customer_name text,
  phone text,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL,
  slip_url text,
  verification_status text NOT NULL DEFAULT 'VERIFIED' CHECK (verification_status IN ('PENDING','VERIFIED','REJECTED')),
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('PENDING','RECEIVED','APPLIED','REFUNDED','PARTIALLY_REFUNDED','FORFEITED','CANCELLED')),
  refunded_amount numeric(12,2) NOT NULL DEFAULT 0,
  applied_order_id int REFERENCES orders(id),
  payment_transaction_id uuid REFERENCES payment_transactions(id),
  received_by int REFERENCES employees(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  shift_id int REFERENCES shifts(id),
  source text NOT NULL DEFAULT 'POS',
  note text,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deposit_refunds (
  id serial PRIMARY KEY,
  refund_no text NOT NULL UNIQUE,
  deposit_id int NOT NULL REFERENCES deposits(id),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  refund_type text NOT NULL DEFAULT 'CASH' CHECK (refund_type IN ('CASH','TRANSFER','QR','CARD','STORE_CREDIT','OTHER')),
  reason text NOT NULL,
  employee_id int REFERENCES employees(id),
  approved_by int REFERENCES employees(id),
  shift_id int REFERENCES shifts(id),
  note text,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
  id serial PRIMARY KEY,
  refund_no text NOT NULL UNIQUE,
  order_id int NOT NULL REFERENCES orders(id),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL,
  reason text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED','COMPLETED')),
  is_full boolean NOT NULL DEFAULT false,
  restock boolean NOT NULL DEFAULT true,
  points_reversed int NOT NULL DEFAULT 0,
  requested_by int REFERENCES employees(id),
  approved_by int REFERENCES employees(id),
  shift_id int REFERENCES shifts(id),
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz
);

CREATE TABLE receipts (
  id serial PRIMARY KEY,
  receipt_no text NOT NULL UNIQUE,
  order_id int NOT NULL UNIQUE REFERENCES orders(id),
  queue_no text,
  snapshot jsonb NOT NULL,
  print_count int NOT NULL DEFAULT 0,
  last_printed_at timestamptz,
  employee_id int REFERENCES employees(id),
  issued_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE point_ledgers (
  id bigserial PRIMARY KEY,
  member_id int NOT NULL REFERENCES members(id),
  type text NOT NULL CHECK (type IN ('EARN','REDEEM','ADJUST','EXPIRE','REFUND','REVERSE')),
  points numeric(12,2) NOT NULL,
  balance_before numeric(12,2) NOT NULL,
  balance_after numeric(12,2) NOT NULL,
  source text NOT NULL DEFAULT 'POS',
  reservation_id int REFERENCES reservations(id),
  order_id int REFERENCES orders(id),
  receipt_id int REFERENCES receipts(id),
  reward_id int REFERENCES rewards(id),
  redemption_id int REFERENCES reward_redemptions(id),
  employee_id int REFERENCES employees(id),
  reason text,
  expires_at timestamptz,
  remaining numeric(12,2),
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX point_ledgers_member_idx ON point_ledgers(member_id, created_at DESC);

-- ───────────────────────── Printing / display ─────────────────────────
CREATE TABLE printers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  connection text NOT NULL DEFAULT 'BROWSER' CHECK (connection IN ('BROWSER','USB','BLUETOOTH','SERIAL','NETWORK')),
  address text,
  port int DEFAULT 9100,
  station text NOT NULL DEFAULT 'MAIN' CHECK (station IN ('MAIN','KITCHEN','BAR','PREP')),
  paper_width int NOT NULL DEFAULT 80,
  density int NOT NULL DEFAULT 8,
  speed int NOT NULL DEFAULT 3,
  margin_mm numeric(4,1) NOT NULL DEFAULT 2,
  copies int NOT NULL DEFAULT 1,
  auto_print boolean NOT NULL DEFAULT true,
  auto_cut boolean NOT NULL DEFAULT true,
  open_drawer boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  device_id int REFERENCES pos_devices(id),
  status text NOT NULL DEFAULT 'UNKNOWN',
  last_seen_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE print_jobs (
  id bigserial PRIMARY KEY,
  printer_id int REFERENCES printers(id),
  job_type text NOT NULL,
  reference text,
  is_copy boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','PRINTING','PRINTED','FAILED','CANCELLED')),
  payload jsonb,
  error text,
  employee_id int REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  printed_at timestamptz
);

CREATE TABLE customer_displays (
  id serial PRIMARY KEY,
  device_id int REFERENCES pos_devices(id),
  pair_code text NOT NULL UNIQUE,
  name text,
  last_state jsonb,
  status text NOT NULL DEFAULT 'OFFLINE',
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE display_pairings (
  id serial PRIMARY KEY,
  display_id int NOT NULL REFERENCES customer_displays(id),
  client_id text NOT NULL,
  user_agent text,
  paired_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  status text NOT NULL DEFAULT 'CONNECTED'
);

-- ───────────────────────── Notifications / logs ─────────────────────────
CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  channel text NOT NULL DEFAULT 'POS' CHECK (channel IN ('POS','LINE','SMS','EMAIL')),
  type text NOT NULL,
  level text NOT NULL DEFAULT 'info',
  title text NOT NULL,
  message text,
  data jsonb NOT NULL DEFAULT '{}',
  member_id int REFERENCES members(id),
  reservation_id int REFERENCES reservations(id),
  room_id int REFERENCES rooms(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED')),
  error text,
  attempts int NOT NULL DEFAULT 0,
  dedupe_key text UNIQUE,
  read_at timestamptz,
  read_by int REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX notifications_channel_idx ON notifications(channel, created_at DESC);

CREATE TABLE activity_logs (
  id bigserial PRIMARY KEY,
  employee_id int REFERENCES employees(id),
  employee_name text,
  action text NOT NULL,
  entity text,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}',
  ip text,
  device_id int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_logs_created_idx ON activity_logs(created_at DESC);
CREATE INDEX activity_logs_entity_idx ON activity_logs(entity, entity_id);
CREATE INDEX activity_logs_employee_idx ON activity_logs(employee_id, created_at DESC);

CREATE TABLE idempotency_keys (
  key text PRIMARY KEY,
  scope text NOT NULL,
  status_code int,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE backups (
  id serial PRIMARY KEY,
  file_name text NOT NULL,
  size_bytes bigint,
  status text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Activity logs and payments are append-only
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_logs_immutable BEFORE UPDATE OR DELETE ON activity_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER point_ledgers_no_delete BEFORE DELETE ON point_ledgers FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER refunds_no_delete BEFORE DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER deposit_refunds_no_delete BEFORE DELETE ON deposit_refunds FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
