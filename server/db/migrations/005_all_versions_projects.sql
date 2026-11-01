-- Additive V5. Review/admin application only; never applied at startup.
BEGIN;
CREATE TABLE axfluxo_video.video_projects(owner_id uuid NOT NULL,id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),project jsonb NOT NULL,PRIMARY KEY(owner_id,id));
CREATE TABLE axfluxo_video.video_project_revisions(owner_id uuid NOT NULL,project_id uuid NOT NULL,revision bigint NOT NULL,project jsonb NOT NULL,PRIMARY KEY(owner_id,project_id,revision),FOREIGN KEY(owner_id,project_id) REFERENCES axfluxo_video.video_projects(owner_id,id) ON DELETE RESTRICT);
CREATE TABLE axfluxo_video.video_project_conflicts(id uuid PRIMARY KEY,owner_id uuid NOT NULL,project_id uuid NOT NULL,expected_revision bigint NOT NULL,current_revision bigint NOT NULL,proposed jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(owner_id,project_id) REFERENCES axfluxo_video.video_projects(owner_id,id) ON DELETE RESTRICT);
CREATE TRIGGER project_history_immutable BEFORE UPDATE OR DELETE ON axfluxo_video.video_project_revisions FOR EACH ROW EXECUTE FUNCTION axfluxo_video.reject_immutable_change();
CREATE TRIGGER project_conflict_immutable BEFORE UPDATE OR DELETE ON axfluxo_video.video_project_conflicts FOR EACH ROW EXECUTE FUNCTION axfluxo_video.reject_immutable_change();
ALTER TABLE axfluxo_video.render_batch_options ADD COLUMN project jsonb;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['video_projects','video_project_revisions','video_project_conflicts'] LOOP
 EXECUTE format('ALTER TABLE axfluxo_video.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE axfluxo_video.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY project_owner ON axfluxo_video.%I TO axfluxo_video_api USING(owner_id=nullif(current_setting(''axfluxo.owner_id'',true),'''')::uuid) WITH CHECK(owner_id=nullif(current_setting(''axfluxo.owner_id'',true),'''')::uuid)',t);
 EXECUTE format('REVOKE ALL ON axfluxo_video.%I FROM PUBLIC',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON axfluxo_video.video_projects,axfluxo_video.video_project_revisions,axfluxo_video.video_project_conflicts TO axfluxo_video_api;
GRANT UPDATE(revision,project) ON axfluxo_video.video_projects TO axfluxo_video_api;
COMMIT;
