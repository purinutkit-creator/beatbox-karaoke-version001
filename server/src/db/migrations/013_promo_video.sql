-- promotion slides can be a video (Customer Display / website banner), not only a picture
ALTER TABLE promotion_images ADD COLUMN IF NOT EXISTS media_type text NOT NULL DEFAULT 'IMAGE';
ALTER TABLE promotion_images DROP CONSTRAINT IF EXISTS promotion_images_media_type_check;
ALTER TABLE promotion_images ADD CONSTRAINT promotion_images_media_type_check CHECK (media_type IN ('IMAGE','VIDEO'));
