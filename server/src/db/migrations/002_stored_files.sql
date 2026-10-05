-- Uploaded files (payment slips, imported fonts) live in the database so the app server keeps no state on disk
-- (works on hosts with ephemeral filesystems such as Render, and survives redeploys/scaling).
CREATE TABLE IF NOT EXISTS stored_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('SLIP', 'FONT')),
  file_name text NOT NULL,
  mime text NOT NULL,
  size_bytes integer NOT NULL,
  sha256 text NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stored_files_kind_idx ON stored_files(kind);
