-- pictures / videos uploaded for promotion slides are kept with the other stored files
ALTER TABLE stored_files DROP CONSTRAINT IF EXISTS stored_files_kind_check;
ALTER TABLE stored_files ADD CONSTRAINT stored_files_kind_check CHECK (kind IN ('SLIP', 'FONT', 'PROMO_MEDIA'));
