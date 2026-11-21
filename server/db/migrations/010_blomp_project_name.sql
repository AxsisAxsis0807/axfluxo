BEGIN;
ALTER TABLE axfluxo_video.blomp_files
  ADD COLUMN IF NOT EXISTS project_name text
  CHECK (char_length(project_name) BETWEEN 1 AND 120);
COMMIT;
