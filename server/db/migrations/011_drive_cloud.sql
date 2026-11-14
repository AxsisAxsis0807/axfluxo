-- Manual, additive. No data deletion and no external resources modified.
BEGIN;
ALTER TABLE axfluxo_video.media_preview_jobs ADD COLUMN drive_runs integer NOT NULL DEFAULT 0 CHECK(drive_runs BETWEEN 0 AND 3);
ALTER TABLE axfluxo_video.drive_connections ADD COLUMN refresh_lease uuid, ADD COLUMN refresh_until timestamptz;
CREATE TABLE axfluxo_video.drive_capacity (
 owner_id uuid PRIMARY KEY REFERENCES axfluxo_video.drive_connections(owner_id),
 limit_bytes bigint NOT NULL CHECK(limit_bytes>0), used_bytes bigint NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
 reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0),
 observed_free bigint NOT NULL CHECK(observed_free>=0), observed_at timestamptz NOT NULL DEFAULT now(),
 CHECK(used_bytes+reserved_bytes<=limit_bytes)
);
CREATE TABLE axfluxo_video.drive_inventory (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES axfluxo_video.drive_connections(owner_id),
 operation_key text NOT NULL, object_key text NOT NULL, namespace text NOT NULL CHECK(namespace IN ('original','segment','candidate','output','preview')),
 job_id uuid, file_id text, parent_id text NOT NULL, account_id text NOT NULL,
 name text NOT NULL, mime text NOT NULL, size bigint NOT NULL CHECK(size>0), hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','verifying','ready','held')),
 session_cipher text, offset_bytes bigint NOT NULL DEFAULT 0 CHECK(offset_bytes>=0),
 lease_token uuid, lease_until timestamptz, error_code text,
 asset_id uuid, version_id uuid, probe jsonb, remote_version text, remote_revision text,
 verify_runs integer NOT NULL DEFAULT 0 CHECK(verify_runs BETWEEN 0 AND 3), verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id), UNIQUE(owner_id,operation_key), UNIQUE(owner_id,object_key), UNIQUE(owner_id,file_id),
 CHECK(offset_bytes<=size),
 FOREIGN KEY(owner_id,job_id) REFERENCES axfluxo_video.render_jobs(owner_id,id),
 FOREIGN KEY(owner_id,version_id) REFERENCES axfluxo_video.media_versions(owner_id,id)
);
CREATE TABLE axfluxo_video.drive_chunks (
 owner_id uuid NOT NULL, object_id uuid NOT NULL, offset_bytes bigint NOT NULL CHECK(offset_bytes>=0),
 size integer NOT NULL CHECK(size>0 AND size<=4194304), hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(owner_id,object_id,offset_bytes),
 FOREIGN KEY(owner_id,object_id) REFERENCES axfluxo_video.drive_inventory(owner_id,id)
);
CREATE TABLE axfluxo_video.drive_batches (
 owner_id uuid NOT NULL, batch_id uuid PRIMARY KEY, render_profile text NOT NULL DEFAULT 'drive-cfr60-crf18-lookahead8-v1', peak_bytes bigint NOT NULL CHECK(peak_bytes>0),
 FOREIGN KEY(owner_id,batch_id) REFERENCES axfluxo_video.render_batches(owner_id,id)
);
CREATE TABLE axfluxo_video.drive_job_capacity (
 owner_id uuid NOT NULL, job_id uuid PRIMARY KEY, remaining bigint NOT NULL CHECK(remaining>=0),
 FOREIGN KEY(owner_id,job_id) REFERENCES axfluxo_video.render_jobs(owner_id,id)
);
CREATE TABLE axfluxo_video.drive_usage (
 owner_id uuid NOT NULL REFERENCES axfluxo_video.developer_memberships(owner_id), event_key text NOT NULL, kind text NOT NULL CHECK(kind IN ('export','upload','download','api')),
 bytes bigint NOT NULL CHECK(bytes>=0), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,event_key)
);
CREATE TABLE axfluxo_video.drive_saved (
 owner_id uuid NOT NULL, output_id uuid NOT NULL, version_id text NOT NULL, hash text NOT NULL,
 destination text NOT NULL CHECK(destination IN ('files','photos')), opened boolean NOT NULL CHECK(opened), confirmed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,output_id,destination),
 FOREIGN KEY(owner_id,output_id) REFERENCES axfluxo_video.render_outputs(owner_id,id)
);
CREATE TABLE axfluxo_video.drive_tickets (
 token_hash text PRIMARY KEY, owner_id uuid NOT NULL, output_id uuid NOT NULL, expires_at timestamptz NOT NULL,
 FOREIGN KEY(owner_id,output_id) REFERENCES axfluxo_video.render_outputs(owner_id,id)
);
CREATE TABLE axfluxo_video.drive_media_tickets (
 token_hash text PRIMARY KEY,owner_id uuid NOT NULL,object_id uuid NOT NULL,expires_at timestamptz NOT NULL,
 FOREIGN KEY(owner_id,object_id) REFERENCES axfluxo_video.drive_inventory(owner_id,id)
);
ALTER TABLE axfluxo_video.drive_media_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE axfluxo_video.drive_media_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY media_ticket_owner ON axfluxo_video.drive_media_tickets TO axfluxo_video_api USING(owner_id=nullif(current_setting('axfluxo.owner_id',true),'')::uuid) WITH CHECK(owner_id=nullif(current_setting('axfluxo.owner_id',true),'')::uuid);
CREATE POLICY media_ticket_redemption ON axfluxo_video.drive_media_tickets FOR SELECT TO axfluxo_video_api USING(token_hash=nullif(current_setting('axfluxo.drive_ticket',true),'') AND expires_at>now());
REVOKE ALL ON axfluxo_video.drive_media_tickets FROM PUBLIC;
GRANT SELECT,INSERT ON axfluxo_video.drive_media_tickets TO axfluxo_video_api;
-- A narrow lock-only function grants no mutation of the global fencing slot.
CREATE FUNCTION axfluxo_video.lock_render_slot() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
 PERFORM id FROM axfluxo_video.render_slot WHERE id=1 FOR UPDATE;
END $$;
REVOKE ALL ON FUNCTION axfluxo_video.lock_render_slot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION axfluxo_video.lock_render_slot() TO axfluxo_video_api;
GRANT UPDATE(state,error_code) ON axfluxo_video.media_preview_jobs TO axfluxo_video_api;
GRANT INSERT ON axfluxo_video.render_executions TO axfluxo_video_api;
GRANT UPDATE(error_code,next_at) ON axfluxo_video.render_executions TO axfluxo_video_api;
GRANT UPDATE(state,locked_until) ON axfluxo_video.outbox_events TO axfluxo_video_api;
GRANT UPDATE(state) ON axfluxo_video.usage_reservations TO axfluxo_video_api;
GRANT INSERT(owner_id) ON axfluxo_video.media_quotas TO axfluxo_video_api;
-- Retain all legacy namespaces and readers.
ALTER TABLE axfluxo_video.render_objects DROP CONSTRAINT render_objects_storage_namespace_check;
ALTER TABLE axfluxo_video.render_objects ADD CONSTRAINT render_objects_storage_namespace_check CHECK(storage_namespace IN ('legacy','outputs-v1','drive-v1'));
DO $$ DECLARE t text; role_name text; BEGIN
 FOREACH t IN ARRAY ARRAY['drive_capacity','drive_inventory','drive_chunks','drive_batches','drive_usage','drive_job_capacity','drive_saved','drive_tickets'] LOOP
 EXECUTE format('ALTER TABLE axfluxo_video.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE axfluxo_video.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON axfluxo_video.%I FROM PUBLIC',t);
 FOREACH role_name IN ARRAY ARRAY['axfluxo_video_api','axfluxo_video_render'] LOOP
 EXECUTE format('CREATE POLICY %I ON axfluxo_video.%I TO %I USING(owner_id=nullif(current_setting(''axfluxo.owner_id'',true),'''')::uuid) WITH CHECK(owner_id=nullif(current_setting(''axfluxo.owner_id'',true),'''')::uuid)',role_name,t,role_name);
 END LOOP;
 END LOOP;
END $$;
GRANT SELECT,INSERT,UPDATE ON axfluxo_video.drive_capacity,axfluxo_video.drive_inventory TO axfluxo_video_api,axfluxo_video_render;
GRANT SELECT,INSERT ON axfluxo_video.drive_usage TO axfluxo_video_api,axfluxo_video_render;
CREATE TRIGGER drive_usage_immutable BEFORE UPDATE OR DELETE ON axfluxo_video.drive_usage FOR EACH ROW EXECUTE FUNCTION axfluxo_video.reject_immutable_change();
GRANT SELECT,INSERT ON axfluxo_video.drive_chunks,axfluxo_video.drive_batches,axfluxo_video.drive_saved,axfluxo_video.drive_tickets TO axfluxo_video_api;
GRANT SELECT ON axfluxo_video.drive_batches TO axfluxo_video_render;
GRANT SELECT,INSERT,UPDATE ON axfluxo_video.drive_job_capacity TO axfluxo_video_api,axfluxo_video_render;
CREATE FUNCTION axfluxo_video.drive_release_peak() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE bytes bigint; BEGIN
 IF NEW.state IN ('succeeded','failed','cancelled') THEN
 UPDATE axfluxo_video.drive_job_capacity SET remaining=0 WHERE owner_id=NEW.owner_id AND job_id=NEW.id RETURNING remaining INTO bytes;
 -- Capture before clearing: handled by the capacity-row trigger below.
 END IF; RETURN NEW; END $$;
CREATE FUNCTION axfluxo_video.drive_peak_delta() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE axfluxo_video.drive_capacity SET reserved_bytes=reserved_bytes+NEW.remaining-OLD.remaining WHERE owner_id=NEW.owner_id;
 RETURN NEW; END $$;
CREATE TRIGGER drive_peak_adjust AFTER UPDATE ON axfluxo_video.drive_job_capacity FOR EACH ROW EXECUTE FUNCTION axfluxo_video.drive_peak_delta();
CREATE TRIGGER drive_terminal_peak AFTER UPDATE OF state ON axfluxo_video.render_jobs FOR EACH ROW EXECUTE FUNCTION axfluxo_video.drive_release_peak();
REVOKE ALL ON FUNCTION axfluxo_video.drive_release_peak(),axfluxo_video.drive_peak_delta() FROM PUBLIC;
GRANT SELECT ON axfluxo_video.drive_connections TO axfluxo_video_render;
GRANT UPDATE(refresh_cipher,connected,refresh_lease,refresh_until) ON axfluxo_video.drive_connections TO axfluxo_video_render;
CREATE POLICY drive_render_owner ON axfluxo_video.drive_connections TO axfluxo_video_render USING(owner_id=nullif(current_setting('axfluxo.owner_id',true),'')::uuid);
CREATE POLICY drive_preview_discovery ON axfluxo_video.drive_inventory FOR SELECT TO axfluxo_video_probe USING(namespace='original' AND state='ready');
CREATE POLICY drive_verification_discovery ON axfluxo_video.drive_inventory FOR SELECT TO axfluxo_video_probe USING(namespace='original' AND state='verifying');
CREATE POLICY drive_ticket_redemption ON axfluxo_video.drive_tickets FOR SELECT TO axfluxo_video_api USING(token_hash=nullif(current_setting('axfluxo.drive_ticket',true),'') AND expires_at>now());
CREATE FUNCTION axfluxo_video.drive_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.owner_id,NEW.id,NEW.operation_key,NEW.object_key,NEW.namespace,NEW.job_id,NEW.parent_id,NEW.account_id,NEW.size,NEW.hash,NEW.mime) IS DISTINCT FROM ROW(OLD.owner_id,OLD.id,OLD.operation_key,OLD.object_key,OLD.namespace,OLD.job_id,OLD.parent_id,OLD.account_id,OLD.size,OLD.hash,OLD.mime)
 OR (OLD.file_id IS NOT NULL AND NEW.file_id IS DISTINCT FROM OLD.file_id)
 OR (OLD.state='ready' AND (NEW.state<>'ready' OR NEW.version_id IS DISTINCT FROM OLD.version_id)) THEN RAISE EXCEPTION 'immutable Drive identity' USING ERRCODE='55000'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER drive_identity_immutable BEFORE UPDATE ON axfluxo_video.drive_inventory FOR EACH ROW EXECUTE FUNCTION axfluxo_video.drive_identity_guard();
REVOKE ALL ON FUNCTION axfluxo_video.drive_identity_guard() FROM PUBLIC;
CREATE INDEX drive_verify_pending ON axfluxo_video.drive_inventory(state,lease_until) WHERE state='verifying';
-- Accounting is attached to the existing fenced publication transaction, exactly once/output.
CREATE FUNCTION axfluxo_video.drive_export_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO axfluxo_video.drive_usage(owner_id,event_key,kind,bytes)
 SELECT NEW.owner_id,'export:'||NEW.output_id::text,'export',o.size FROM axfluxo_video.render_objects o
 WHERE o.owner_id=NEW.owner_id AND o.id=NEW.object_id AND o.storage_namespace='drive-v1'
 ON CONFLICT DO NOTHING;
 RETURN NEW; END $$;
CREATE TRIGGER drive_export_once AFTER INSERT ON axfluxo_video.render_artifacts FOR EACH ROW EXECUTE FUNCTION axfluxo_video.drive_export_ledger();
REVOKE ALL ON FUNCTION axfluxo_video.drive_export_ledger() FROM PUBLIC;
COMMIT;
