BEGIN;
ALTER TABLE axfluxo_video.blomp_files
  DROP CONSTRAINT blomp_files_role_check,
  ADD CONSTRAINT blomp_files_role_check
    CHECK(role IN ('inputs','originals','intermediates','checkpoints','outputs'));
COMMIT;
