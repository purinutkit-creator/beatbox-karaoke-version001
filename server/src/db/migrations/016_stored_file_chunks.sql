-- Large uploads (promotion videos) are stored in small pieces: one huge bytea value needs several times its size in
-- database memory while it is written, which crashed the small hosted database. 512 KB pieces keep every query small.
CREATE TABLE IF NOT EXISTS stored_file_chunks (
  file_id uuid NOT NULL REFERENCES stored_files(id) ON DELETE CASCADE,
  seq int NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (file_id, seq)
);
-- video / pictures are already compressed: don't try to compress them again
ALTER TABLE stored_file_chunks ALTER COLUMN data SET STORAGE EXTERNAL;
ALTER TABLE stored_files ADD COLUMN IF NOT EXISTS chunked boolean NOT NULL DEFAULT false;
-- false while the pieces are still being uploaded (never served)
ALTER TABLE stored_files ADD COLUMN IF NOT EXISTS complete boolean NOT NULL DEFAULT true;
