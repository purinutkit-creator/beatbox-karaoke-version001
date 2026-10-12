-- Direct USB printing with the store's font (rendered like the earlier system), printer search by USB id,
-- real deletion of printers from the list, "use this printer for every document".
ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_render_mode_check;
ALTER TABLE printers ADD CONSTRAINT printers_render_mode_check CHECK (render_mode IN ('DRIVER','RASTER','ESCPOS_TEXT'));
ALTER TABLE printers ADD COLUMN IF NOT EXISTS usb_vendor_id int;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS usb_product_id int;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS usb_serial text;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
-- printers connected directly (USB / Serial / Bluetooth / Network) print the store font again, as before 006
UPDATE printers SET render_mode = 'RASTER' WHERE connection <> 'BROWSER' AND render_mode IN ('DRIVER', 'ESCPOS_TEXT');
-- the old "delete" button only switched printers off; those were meant to be gone from the list
UPDATE printers SET deleted_at = now() WHERE NOT is_active AND deleted_at IS NULL;
