-- Store login: a device first enters the store code (8 random characters, e.g. 58bksn3j), then the store account
-- (username or e-mail + password); staff then use their 4-digit PIN inside the store.
CREATE OR REPLACE FUNCTION bb_random_store_code() RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  chars text := 'abcdefghjkmnpqrstuvwxyz23456789'; -- no 0/o, 1/l/i look-alikes
  code text;
BEGIN
  LOOP
    code := '';
    FOR i IN 1..8 LOOP
      code := code || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    END LOOP;
    -- always contains a digit and a letter, like 58bksn3j
    CONTINUE WHEN code !~ '[0-9]' OR code !~ '[a-z]';
    EXIT WHEN NOT EXISTS (SELECT 1 FROM stores WHERE lower(store_code) = code);
  END LOOP;
  RETURN code;
END $$;

ALTER TABLE stores ADD COLUMN IF NOT EXISTS store_code text;
-- store sessions of devices carry this number; raising it signs every device out of the store
ALTER TABLE stores ADD COLUMN IF NOT EXISTS login_version int NOT NULL DEFAULT 1;
UPDATE stores SET store_code = bb_random_store_code() WHERE store_code IS NULL;
ALTER TABLE stores ALTER COLUMN store_code SET DEFAULT bb_random_store_code();
ALTER TABLE stores ALTER COLUMN store_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stores_store_code_uq ON stores(lower(store_code));

-- store account = the owner employee: username or e-mail + password
ALTER TABLE employees ADD COLUMN IF NOT EXISTS username text;
-- starting password (set by the system / the Super Owner), kept encrypted only until the owner changes it,
-- so the Super Owner and the owner can see it; cleared when the password is changed
ALTER TABLE employees ADD COLUMN IF NOT EXISTS initial_password_enc text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_changed_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS employees_store_username_uq ON employees(store_id, lower(username)) WHERE username IS NOT NULL AND deleted_at IS NULL;
