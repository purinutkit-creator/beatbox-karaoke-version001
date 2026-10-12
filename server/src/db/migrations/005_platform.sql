-- Platform level (not per store): Super Owner accounts, plans, subscriptions and their history.

CREATE TABLE IF NOT EXISTS platform_users (
  id serial PRIMARY KEY,
  username text NOT NULL,
  display_name text,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'SUPER_OWNER' CHECK (role IN ('SUPER_OWNER')),
  is_active boolean NOT NULL DEFAULT true,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  password_changed_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_users_username_uq ON platform_users(lower(username));

CREATE TABLE IF NOT EXISTS platform_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_user_id int NOT NULL REFERENCES platform_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

-- Plans: 4 rows, everything editable by the Super Owner (names, prices, features, limits)
CREATE TABLE IF NOT EXISTS plans (
  id serial PRIMARY KEY,
  name text NOT NULL,
  description text,
  price numeric(12,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'THB',
  billing_cycle text NOT NULL DEFAULT 'MONTH' CHECK (billing_cycle IN ('DAY','MONTH','YEAR')),
  billing_interval int NOT NULL DEFAULT 1 CHECK (billing_interval > 0),
  features jsonb NOT NULL DEFAULT '{}',
  limits jsonb NOT NULL DEFAULT '{}',
  is_public boolean NOT NULL DEFAULT true,
  trial_days int NOT NULL DEFAULT 14,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Current subscription of each store
CREATE TABLE IF NOT EXISTS store_subscriptions (
  store_id int PRIMARY KEY REFERENCES stores(id),
  plan_id int REFERENCES plans(id),
  status text NOT NULL DEFAULT 'TRIAL' CHECK (status IN ('TRIAL','ACTIVE','SUSPENDED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,            -- NULL = no expiry
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- History: register, trial, renew, change plan, suspend, activate (who and when)
CREATE TABLE IF NOT EXISTS subscription_events (
  id bigserial PRIMARY KEY,
  store_id int NOT NULL REFERENCES stores(id),
  action text NOT NULL,
  before jsonb,
  after jsonb,
  note text,
  actor_type text NOT NULL,          -- PLATFORM | OWNER | SYSTEM
  actor_id int,
  actor_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_events_store_idx ON subscription_events(store_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS renewal_requests (
  id serial PRIMARY KEY,
  store_id int NOT NULL REFERENCES stores(id),
  plan_id int REFERENCES plans(id),
  message text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','REJECTED')),
  requested_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  handled_at timestamptz,
  handled_by int REFERENCES platform_users(id)
);

-- default plans (edited from the Super Owner console afterwards)
INSERT INTO plans(name, description, price, billing_cycle, billing_interval, features, limits, is_public, trial_days, sort_order)
SELECT * FROM (VALUES
  ('Starter', 'ร้านเล็ก เริ่มต้นใช้งาน POS และเปิดห้อง', 590::numeric, 'MONTH', 1,
    '{"pos":true,"rooms":true,"booking":false,"members":false,"promotions":false,"stock":false,"reports":true,"display":false,"receipt_settings":true,"printing":true,"staff":false,"multi_branch":false}'::jsonb,
    '{"branches":1,"rooms":5,"employees":3,"devices":1}'::jsonb, true, 14, 1),
  ('Standard', 'ครบสำหรับร้านทั่วไป จองห้อง สมาชิก และหน้าจอลูกค้า', 990::numeric, 'MONTH', 1,
    '{"pos":true,"rooms":true,"booking":true,"members":true,"promotions":true,"stock":false,"reports":true,"display":true,"receipt_settings":true,"printing":true,"staff":true,"multi_branch":false}'::jsonb,
    '{"branches":1,"rooms":15,"employees":10,"devices":3}'::jsonb, true, 14, 2),
  ('Pro', 'ทุกฟังก์ชัน รวมสต็อก โปรโมชั่น และรายงานเต็มรูปแบบ', 1590::numeric, 'MONTH', 1,
    '{"pos":true,"rooms":true,"booking":true,"members":true,"promotions":true,"stock":true,"reports":true,"display":true,"receipt_settings":true,"printing":true,"staff":true,"multi_branch":false}'::jsonb,
    '{"branches":1,"rooms":40,"employees":30,"devices":10}'::jsonb, true, 14, 3),
  ('Enterprise', 'หลายสาขา ไม่จำกัดห้องและพนักงาน', 15900::numeric, 'YEAR', 1,
    '{"pos":true,"rooms":true,"booking":true,"members":true,"promotions":true,"stock":true,"reports":true,"display":true,"receipt_settings":true,"printing":true,"staff":true,"multi_branch":true}'::jsonb,
    '{}'::jsonb, true, 14, 4)
) AS v(name, description, price, billing_cycle, billing_interval, features, limits, is_public, trial_days, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM plans);

-- the original store keeps working: top plan, active, no expiry
INSERT INTO store_subscriptions(store_id, plan_id, status, started_at, expires_at)
SELECT s.id, (SELECT id FROM plans ORDER BY sort_order DESC, id DESC LIMIT 1), 'ACTIVE', now(), NULL
FROM stores s WHERE NOT EXISTS (SELECT 1 FROM store_subscriptions x WHERE x.store_id = s.id);

INSERT INTO platform_settings(key, value) VALUES
  ('signup', '{"enabled": true, "trialDays": 14, "contactPhone": "", "contactLine": "", "contactEmail": ""}')
ON CONFLICT (key) DO NOTHING;
