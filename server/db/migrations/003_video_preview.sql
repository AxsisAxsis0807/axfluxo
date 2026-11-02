BEGIN;
CREATE TABLE axfluxo_video.media_preview_jobs (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, version_id uuid NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','generating','ready','failed')),
 lease_token uuid, lease_until timestamptz, plan jsonb, metadata jsonb,
 compute_units bigint NOT NULL DEFAULT 0 CHECK(compute_units>=0),
 reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0), error_code text,
 UNIQUE(owner_id,version_id),
 FOREIGN KEY(owner_id) REFERENCES axfluxo_video.usage_budgets(owner_id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_id,version_id) REFERENCES axfluxo_video.media_versions(owner_id,id) ON DELETE RESTRICT
);
ALTER TABLE axfluxo_video.media_preview_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE axfluxo_video.media_preview_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON axfluxo_video.media_preview_jobs TO axfluxo_video_api USING(owner_id=nullif(current_setting('axfluxo.owner_id',true),'')::uuid) WITH CHECK(owner_id=nullif(current_setting('axfluxo.owner_id',true),'')::uuid);
CREATE POLICY preview_discovery ON axfluxo_video.media_preview_jobs FOR SELECT TO axfluxo_video_probe USING(true);
REVOKE ALL ON axfluxo_video.media_preview_jobs FROM PUBLIC;
DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
 IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
 EXECUTE format('REVOKE ALL ON SCHEMA axfluxo_video FROM %I',r);
 EXECUTE format('REVOKE ALL ON axfluxo_video.media_preview_jobs FROM %I',r);
 END IF; END LOOP; END $$;
GRANT SELECT,INSERT ON axfluxo_video.media_preview_jobs TO axfluxo_video_api;
GRANT UPDATE ON axfluxo_video.media_preview_jobs TO axfluxo_video_probe;
GRANT UPDATE(consumed_units) ON axfluxo_video.usage_budgets TO axfluxo_video_probe;
COMMIT;
