-- what was actually sent to Tuya and what came back (for diagnosing devices that do not react)
ALTER TABLE smart_logs ADD COLUMN IF NOT EXISTS detail jsonb;
