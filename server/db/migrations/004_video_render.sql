-- Additive V4 only. Never auto-applied by API/worker. No original deletion/downgrade.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='axfluxo_video_render') THEN
 CREATE ROLE axfluxo_video_render NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='axfluxo_video_render' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
 RAISE EXCEPTION 'unsafe render role'; END IF;
END $$;
CREATE TABLE axfluxo_video.render_batch_options (
 owner_id uuid NOT NULL, batch_id uuid PRIMARY KEY, mode text NOT NULL CHECK(mode='all-versions'),
 FOREIGN KEY(owner_id,batch_id) REFERENCES axfluxo_video.render_batches(owner_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER render_options_immutable BEFORE UPDATE OR DELETE ON axfluxo_video.render_batch_options FOR EACH ROW EXECUTE FUNCTION axfluxo_video.reject_immutable_change();
CREATE TABLE axfluxo_video.render_executions (
 owner_id uuid NOT NULL, job_id uuid PRIMARY KEY, token bigint NOT NULL DEFAULT 0,
 runs integer NOT NULL DEFAULT 0 CHECK(runs BETWEEN 0 AND 3),
 next_at timestamptz NOT NULL DEFAULT now(), progress_frame bigint NOT NULL DEFAULT 0 CHECK(progress_frame>=0),
 total_frames bigint NOT NULL DEFAULT 0 CHECK(total_frames>=0), error_code text,
 UNIQUE(owner_id,job_id),
 FOREIGN KEY(owner_id,job_id) REFERENCES axfluxo_video.render_jobs(owner_id,id) ON DELETE RESTRICT
);
-- One leased slot across all workers, not merely one process-local semaphore.
CREATE TABLE axfluxo_video.render_slot (
 id integer PRIMARY KEY CHECK(id=1), token bigint NOT NULL DEFAULT 0,
 owner_id uuid, job_id uuid, lease_until timestamptz,
 FOREIGN KEY(owner_id,job_id) REFERENCES axfluxo_video.render_jobs(owner_id,id) ON DELETE RESTRICT,
 CHECK((job_id IS NULL)=(lease_until IS NULL)), CHECK((job_id IS NULL)=(owner_id IS NULL))
);
INSERT INTO axfluxo_video.render_slot(id) VALUES(1);
CREATE TABLE axfluxo_video.render_objects (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, job_id uuid NOT NULL,
 object_key text NOT NULL UNIQUE CHECK(object_key ~ '^render-(staging|outputs)/'),
 hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'), size bigint NOT NULL CHECK(size>0),
 kind text NOT NULL CHECK(kind IN ('segment','candidate','output')), segment_index integer,
 plan_hash text NOT NULL CHECK(plan_hash ~ '^[a-f0-9]{64}$'), ready boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,job_id) REFERENCES axfluxo_video.render_jobs(owner_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_id) REFERENCES axfluxo_video.media_quotas(owner_id) ON DELETE RESTRICT
);
CREATE INDEX render_checkpoints ON axfluxo_video.render_objects(owner_id,job_id,plan_hash,segment_index) WHERE kind='segment' AND ready;
CREATE TABLE axfluxo_video.render_artifacts (
 owner_id uuid NOT NULL, output_id uuid PRIMARY KEY, object_id uuid NOT NULL,
 validation jsonb NOT NULL, UNIQUE(owner_id,output_id),
 FOREIGN KEY(owner_id,output_id) REFERENCES axfluxo_video.render_outputs(owner_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_id,object_id) REFERENCES axfluxo_video.render_objects(owner_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON axfluxo_video.render_artifacts FOR EACH ROW EXECUTE FUNCTION axfluxo_video.reject_immutable_change();
CREATE FUNCTION axfluxo_video.guard_render_object() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'ready') IS DISTINCT FROM (to_jsonb(OLD)-'ready') OR OLD.ready THEN
 RAISE EXCEPTION 'immutable render object' USING ERRCODE='55000'; END IF; RETURN NEW; END $$;
CREATE TRIGGER render_object_immutable BEFORE UPDATE OR DELETE ON axfluxo_video.render_objects FOR EACH ROW EXECUTE FUNCTION axfluxo_video.guard_render_object();
-- A fencing check at the DB boundary as well as the application's locked transaction.
CREATE FUNCTION axfluxo_video.guard_render_output() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT FROM axfluxo_video.render_slot s JOIN axfluxo_video.render_executions e ON e.job_id=s.job_id AND e.owner_id=s.owner_id
 JOIN axfluxo_video.render_jobs j ON j.id=s.job_id AND j.owner_id=s.owner_id
 WHERE s.id=1 AND s.owner_id=NEW.owner_id AND s.job_id=NEW.job_id AND s.token=e.token
 AND s.token=nullif(current_setting('axfluxo.render_token',true),'')::bigint
 AND s.lease_until>clock_timestamp() AND j.state='running') THEN
 RAISE EXCEPTION 'stale render fence' USING ERRCODE='55000'; END IF; RETURN NEW; END $$;
CREATE TRIGGER render_output_fenced BEFORE INSERT ON axfluxo_video.render_outputs FOR EACH ROW EXECUTE FUNCTION axfluxo_video.guard_render_output();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['render_batch_options','render_executions','render_objects','render_artifacts'] LOOP
 EXECUTE format('ALTER TABLE axfluxo_video.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE axfluxo_video.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY owner_api ON axfluxo_video.%I TO axfluxo_video_api USING(owner_id=nullif(current_setting(''axfluxo.owner_id'',true),'''')::uuid)',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['render_batch_options','render_executions','render_objects','render_artifacts','render_batches','render_jobs','render_outputs','resource_versions','resource_pins','outbox_events','usage_budgets','usage_reservations','developer_memberships','media_versions','media_quotas'] LOOP
 EXECUTE format('CREATE POLICY render_owner ON axfluxo_video.%I TO axfluxo_video_render USING(owner_id=nullif(current_setting(''axfluxo.owner_id'',true),'''')::uuid) WITH CHECK(owner_id=nullif(current_setting(''axfluxo.owner_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
CREATE POLICY render_job_discovery ON axfluxo_video.render_jobs FOR SELECT TO axfluxo_video_render USING(true);
CREATE POLICY render_execution_discovery ON axfluxo_video.render_executions FOR SELECT TO axfluxo_video_render USING(true);
REVOKE ALL ON axfluxo_video.render_slot,axfluxo_video.render_executions,axfluxo_video.render_objects,axfluxo_video.render_artifacts FROM PUBLIC;
REVOKE ALL ON FUNCTION axfluxo_video.guard_render_output(),axfluxo_video.guard_render_object() FROM PUBLIC;
GRANT SELECT ON axfluxo_video.render_batch_options TO axfluxo_video_render;
GRANT SELECT,INSERT ON axfluxo_video.render_batch_options TO axfluxo_video_api;
REVOKE ALL ON axfluxo_video.render_batch_options FROM PUBLIC;
GRANT USAGE ON SCHEMA axfluxo_video TO axfluxo_video_render;
GRANT SELECT ON axfluxo_video.render_slot,axfluxo_video.render_executions,axfluxo_video.render_objects,axfluxo_video.render_artifacts,
 axfluxo_video.render_batches,axfluxo_video.render_jobs,axfluxo_video.render_outputs,axfluxo_video.resource_versions,axfluxo_video.resource_pins,
 axfluxo_video.outbox_events,axfluxo_video.usage_budgets,axfluxo_video.usage_reservations,axfluxo_video.developer_memberships,
 axfluxo_video.media_versions,axfluxo_video.media_quotas TO axfluxo_video_render;
GRANT SELECT ON axfluxo_video.render_executions,axfluxo_video.render_artifacts,axfluxo_video.render_objects TO axfluxo_video_api;
GRANT INSERT ON axfluxo_video.render_executions,axfluxo_video.render_objects,axfluxo_video.render_artifacts,axfluxo_video.render_outputs,axfluxo_video.resource_versions TO axfluxo_video_render;
GRANT UPDATE ON axfluxo_video.render_slot,axfluxo_video.render_executions TO axfluxo_video_render;
GRANT UPDATE(ready) ON axfluxo_video.render_objects TO axfluxo_video_render;
GRANT UPDATE(state) ON axfluxo_video.render_jobs,axfluxo_video.usage_reservations TO axfluxo_video_render;
GRANT UPDATE(state,locked_until,delivery_attempts) ON axfluxo_video.outbox_events TO axfluxo_video_render;
GRANT UPDATE(reserved_units,consumed_units) ON axfluxo_video.usage_budgets TO axfluxo_video_render;
GRANT UPDATE(reserved_bytes,used_bytes) ON axfluxo_video.media_quotas TO axfluxo_video_render;
GRANT UPDATE(created_at) ON axfluxo_video.developer_memberships TO axfluxo_video_render;
COMMIT;
