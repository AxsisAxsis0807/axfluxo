-- Additive, manual approval only; never run at service startup.
BEGIN;
ALTER TABLE axfluxo_video.render_objects ADD COLUMN storage_namespace text NOT NULL DEFAULT 'legacy' CHECK(storage_namespace IN ('legacy','outputs-v1'));
CREATE TABLE axfluxo_video.output_deletions (
 owner_id uuid NOT NULL, output_id uuid PRIMARY KEY, object_id uuid NOT NULL,
 version_id text NOT NULL, hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'),
 photo_library_checked boolean NOT NULL CHECK(photo_library_checked),
 confirmed_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','held','deleting','deleted')),
 reason text, deleted_at timestamptz, next_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,output_id), UNIQUE(owner_id,object_id),
 FOREIGN KEY(owner_id,output_id) REFERENCES axfluxo_video.render_outputs(owner_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_id,object_id) REFERENCES axfluxo_video.render_objects(owner_id,id) ON DELETE RESTRICT
);
CREATE TABLE axfluxo_video.push_subscriptions (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES axfluxo_video.developer_memberships(owner_id) ON DELETE RESTRICT,
 endpoint_hash text NOT NULL UNIQUE, subscription jsonb NOT NULL, UNIQUE(owner_id,id),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE axfluxo_video.notification_deliveries (
 owner_id uuid NOT NULL, batch_id uuid NOT NULL, fingerprint text NOT NULL,
 subscription_id uuid NOT NULL,
 FOREIGN KEY(owner_id,subscription_id) REFERENCES axfluxo_video.push_subscriptions(owner_id,id) ON DELETE RESTRICT,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','expired','held')),
 attempts integer NOT NULL DEFAULT 0, next_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,batch_id,fingerprint,subscription_id),
 FOREIGN KEY(owner_id,batch_id) REFERENCES axfluxo_video.render_batches(owner_id,id) ON DELETE RESTRICT
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['output_deletions','push_subscriptions','notification_deliveries'] LOOP
 EXECUTE format('ALTER TABLE axfluxo_video.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE axfluxo_video.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON axfluxo_video.%I FROM PUBLIC',t);
 EXECUTE format('CREATE POLICY owner_api ON axfluxo_video.%I TO axfluxo_video_api USING(owner_id=nullif(current_setting(''axfluxo.owner_id'',true),'''')::uuid) WITH CHECK(owner_id=nullif(current_setting(''axfluxo.owner_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON axfluxo_video.output_deletions TO axfluxo_video_api;
GRANT SELECT,INSERT ON axfluxo_video.push_subscriptions TO axfluxo_video_api;
GRANT UPDATE(subscription,active) ON axfluxo_video.push_subscriptions TO axfluxo_video_api;
-- Separate logins must inherit only their respective worker role, never the API/render roles.
DO $$ DECLARE worker text; t text; BEGIN
 FOREACH worker IN ARRAY ARRAY['axfluxo_video_delete','axfluxo_video_notify'] LOOP
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=worker) THEN EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS',worker); END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname=worker AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN RAISE EXCEPTION 'unsafe worker role'; END IF;
 EXECUTE format('GRANT USAGE ON SCHEMA axfluxo_video TO %I',worker);
 FOREACH t IN ARRAY (CASE WHEN worker='axfluxo_video_delete' THEN ARRAY['developer_memberships','render_outputs','render_artifacts','render_batch_options','render_objects','resource_pins','video_projects','video_project_revisions','video_project_conflicts','media_quotas','output_deletions'] ELSE ARRAY['developer_memberships','render_batches','render_jobs','push_subscriptions','notification_deliveries'] END) LOOP
 IF to_regclass('axfluxo_video.'||t) IS NOT NULL THEN
 EXECUTE format('GRANT SELECT ON axfluxo_video.%I TO %I',t,worker);
 EXECUTE format('CREATE POLICY %I ON axfluxo_video.%I TO %I USING(owner_id=nullif(current_setting(''axfluxo.owner_id'',true),'''')::uuid)',worker,t,worker);
 END IF;
 END LOOP;
 END LOOP;
END $$;
GRANT UPDATE(created_at) ON axfluxo_video.developer_memberships TO axfluxo_video_delete,axfluxo_video_notify;
CREATE POLICY deletion_membership_discovery ON axfluxo_video.developer_memberships FOR SELECT TO axfluxo_video_delete USING(true);
CREATE POLICY deletion_discovery ON axfluxo_video.output_deletions FOR SELECT TO axfluxo_video_delete USING(true);
CREATE POLICY notification_discovery ON axfluxo_video.push_subscriptions FOR SELECT TO axfluxo_video_notify USING(true);
GRANT UPDATE(state,reason,deleted_at,next_at) ON axfluxo_video.output_deletions TO axfluxo_video_delete;
GRANT UPDATE(used_bytes) ON axfluxo_video.media_quotas TO axfluxo_video_delete;
GRANT INSERT,UPDATE ON axfluxo_video.notification_deliveries TO axfluxo_video_notify;
GRANT UPDATE(active) ON axfluxo_video.push_subscriptions TO axfluxo_video_notify;
GRANT SELECT ON axfluxo_video.output_deletions TO axfluxo_video_render;
CREATE POLICY render_output_retention ON axfluxo_video.output_deletions TO axfluxo_video_render USING(owner_id=nullif(current_setting('axfluxo.owner_id',true),'')::uuid);
CREATE INDEX output_delete_pending ON axfluxo_video.output_deletions(next_at,confirmed_at) WHERE state<>'deleted';
CREATE INDEX active_push_owners ON axfluxo_video.push_subscriptions(owner_id) WHERE active;
CREATE INDEX notification_pending ON axfluxo_video.notification_deliveries(owner_id,next_at) WHERE state='pending';
-- Serialize every new pin/project reference with deletion; fail closed once bytes are being removed.
CREATE FUNCTION axfluxo_video.guard_deleted_reference() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,axfluxo_video AS $$
DECLARE d record; BEGIN
 FOR d IN SELECT owner_id,version_id,object_id FROM axfluxo_video.output_deletions WHERE owner_id=NEW.owner_id ORDER BY version_id,output_id LOOP
 PERFORM pg_advisory_xact_lock(hashtextextended('output-version:'||d.owner_id::text||':'||d.version_id,0));
 IF EXISTS(SELECT FROM axfluxo_video.output_deletions WHERE owner_id=d.owner_id AND version_id=d.version_id AND state IN ('deleting','deleted'))
 AND (position(d.version_id in to_jsonb(NEW)::text)>0 OR (TG_TABLE_NAME='render_artifacts' AND to_jsonb(NEW)->>'object_id'=d.object_id::text)) THEN RAISE EXCEPTION 'output unavailable' USING ERRCODE='55000'; END IF;
 END LOOP; RETURN NEW; END $$;
REVOKE ALL ON FUNCTION axfluxo_video.guard_deleted_reference() FROM PUBLIC;
CREATE TRIGGER protect_output_pin BEFORE INSERT ON axfluxo_video.resource_pins FOR EACH ROW EXECUTE FUNCTION axfluxo_video.guard_deleted_reference();
CREATE TRIGGER protect_output_project BEFORE INSERT OR UPDATE ON axfluxo_video.video_projects FOR EACH ROW EXECUTE FUNCTION axfluxo_video.guard_deleted_reference();
CREATE TRIGGER protect_output_revision BEFORE INSERT ON axfluxo_video.video_project_revisions FOR EACH ROW EXECUTE FUNCTION axfluxo_video.guard_deleted_reference();
CREATE TRIGGER protect_output_conflict BEFORE INSERT ON axfluxo_video.video_project_conflicts FOR EACH ROW EXECUTE FUNCTION axfluxo_video.guard_deleted_reference();
CREATE TRIGGER protect_output_artifact BEFORE INSERT ON axfluxo_video.render_artifacts FOR EACH ROW EXECUTE FUNCTION axfluxo_video.guard_deleted_reference();
CREATE TRIGGER protect_output_batch_project BEFORE INSERT ON axfluxo_video.render_batch_options FOR EACH ROW EXECUTE FUNCTION axfluxo_video.guard_deleted_reference();
COMMIT;
