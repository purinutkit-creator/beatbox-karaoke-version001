-- Free extra minutes (e.g. "+5 นาที" with a reason): extends the room without adding a charge
ALTER TABLE room_sessions ADD COLUMN IF NOT EXISTS bonus_minutes int NOT NULL DEFAULT 0;

-- Kitchen / bar tickets: buzzer on the receipt printer when a kitchen ticket prints ("ปิ๊บๆ" = new order)
ALTER TABLE printers ADD COLUMN IF NOT EXISTS beep_kitchen boolean NOT NULL DEFAULT true;
ALTER TABLE printers ADD COLUMN IF NOT EXISTS beep_times int NOT NULL DEFAULT 3;
-- find unsent food/drink items quickly (automatic kitchen tickets)
CREATE INDEX IF NOT EXISTS order_items_kitchen_pending_idx ON order_items(order_id) WHERE kitchen_status = 'NONE' AND station <> 'NONE' AND voided_at IS NULL;
