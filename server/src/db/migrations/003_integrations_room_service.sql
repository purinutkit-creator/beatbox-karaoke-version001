-- Integration credentials managed from the admin UI (LINE / SMS / slip verification / payment terminal).
-- Non-secret values live in `config`; API keys and secrets are AES-256-GCM encrypted in `secrets`.
CREATE TABLE IF NOT EXISTS integration_settings (
  key text PRIMARY KEY CHECK (key IN ('line', 'sms', 'slip', 'terminal')),
  config jsonb NOT NULL DEFAULT '{}',
  secrets text,
  updated_by int REFERENCES employees(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Extra microphones (price set by admin) on bookings and room sessions
ALTER TABLE room_sessions ADD COLUMN IF NOT EXISTS extra_mics int NOT NULL DEFAULT 0 CHECK (extra_mics >= 0);
ALTER TABLE room_sessions ADD COLUMN IF NOT EXISTS mic_fee numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS extra_mics int NOT NULL DEFAULT 0 CHECK (extra_mics >= 0);

-- One-time in-room ordering link printed on the customer's room ticket (valid only while the session runs)
ALTER TABLE room_sessions ADD COLUMN IF NOT EXISTS order_token text UNIQUE;

-- Orders placed by customers from the in-room QR
CREATE TABLE IF NOT EXISTS room_customer_orders (
  id serial PRIMARY KEY,
  session_id int NOT NULL REFERENCES room_sessions(id),
  order_id int NOT NULL REFERENCES orders(id),
  items jsonb NOT NULL,
  item_ids int[] NOT NULL DEFAULT '{}',
  amount numeric(12,2) NOT NULL,
  pay_mode text NOT NULL CHECK (pay_mode IN ('NOW', 'COUNTER')),
  status text NOT NULL DEFAULT 'PLACED' CHECK (status IN ('AWAITING_PAYMENT', 'VERIFYING', 'PLACED', 'CANCELLED')),
  payment_status text NOT NULL DEFAULT 'NONE' CHECK (payment_status IN ('NONE', 'PENDING', 'AUTO_ACCEPTED', 'VERIFIED', 'REJECTED')),
  deposit_id int REFERENCES deposits(id),
  verification_id int REFERENCES payment_verifications(id),
  slip_ref text,
  submitted_at timestamptz,
  accepted_at timestamptz,
  verified_by int REFERENCES employees(id),
  verified_at timestamptz,
  reject_reason text,
  client_op_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_customer_orders_session_idx ON room_customer_orders(session_id);

-- Problems reported by customers from the room
CREATE TABLE IF NOT EXISTS room_issues (
  id serial PRIMARY KEY,
  session_id int REFERENCES room_sessions(id),
  room_id int NOT NULL REFERENCES rooms(id),
  category text NOT NULL,
  message text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  acknowledged_by int REFERENCES employees(id),
  acknowledged_at timestamptz,
  resolved_by int REFERENCES employees(id),
  resolved_at timestamptz,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_issues_open_idx ON room_issues(room_id) WHERE status <> 'RESOLVED';

-- Payments pushed to a payment terminal (EDC / Beam Bolt)
CREATE TABLE IF NOT EXISTS terminal_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  order_id int REFERENCES orders(id),
  reference text,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'CANCELLED', 'EXPIRED', 'ERROR')),
  provider_ref text,
  approval_code text,
  deep_link text,
  raw jsonb,
  error text,
  employee_id int REFERENCES employees(id),
  confirmed_manually_by int REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS terminal_payments_provider_ref_idx ON terminal_payments(provider, provider_ref);

-- Print jobs created by the server (e.g. kitchen tickets of in-room QR orders) are claimed by one POS device
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS claimed_by text;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
CREATE INDEX IF NOT EXISTS print_jobs_queued_idx ON print_jobs(created_at) WHERE status = 'QUEUED';
