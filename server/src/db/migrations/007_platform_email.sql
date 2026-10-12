-- Super Owner (Super Admin) can log in with an e-mail address as well as the login name.
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS email text;
CREATE UNIQUE INDEX IF NOT EXISTS platform_users_email_uq ON platform_users(lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS platform_users_username_uq ON platform_users(lower(username));
