-- print speed: 0 = leave the printer as it is, 1 (slowest) … 9 (fastest). The old value was never sent to a printer.
ALTER TABLE printers ALTER COLUMN speed SET DEFAULT 0;
UPDATE printers SET speed = 0;

-- kitchen / bar ticket alert: the printer's buzzer, a sound on the device that prints, both, or none
ALTER TABLE printers ADD COLUMN IF NOT EXISTS kitchen_alert text NOT NULL DEFAULT 'PRINTER';
UPDATE printers SET kitchen_alert = 'OFF' WHERE beep_kitchen = false;
ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_kitchen_alert_check;
ALTER TABLE printers ADD CONSTRAINT printers_kitchen_alert_check CHECK (kitchen_alert IN ('OFF','PRINTER','DEVICE','BOTH'));
-- a built-in sound key (beep, ding, bell …) or an uploaded / recorded sound file (/uploads/media/<id>.<ext>)
ALTER TABLE printers ADD COLUMN IF NOT EXISTS alert_sound text NOT NULL DEFAULT 'beep';
ALTER TABLE printers ADD COLUMN IF NOT EXISTS alert_sound_name text;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS alert_volume int NOT NULL DEFAULT 80;
-- BEFORE = sound first, then the ticket prints · AFTER = the ticket prints, then the sound
ALTER TABLE printers ADD COLUMN IF NOT EXISTS alert_order text NOT NULL DEFAULT 'BEFORE';
ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_alert_order_check;
ALTER TABLE printers ADD CONSTRAINT printers_alert_order_check CHECK (alert_order IN ('BEFORE','AFTER'));

-- uploaded / recorded alert sounds are kept with the other stored files
ALTER TABLE stored_files DROP CONSTRAINT IF EXISTS stored_files_kind_check;
ALTER TABLE stored_files ADD CONSTRAINT stored_files_kind_check CHECK (kind IN ('SLIP', 'FONT', 'PROMO_MEDIA', 'SOUND'));
