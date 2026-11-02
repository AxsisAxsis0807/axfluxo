-- Additive V2 only. No bucket provisioning, existing schema rewrite or down migration.
BEGIN;
CREATE TABLE axfluxo_video.media_folders (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, parent_id uuid, name text NOT NULL,
 system_key text, UNIQUE(owner_id,id), UNIQUE(owner_id,system_key),
 CHECK(system_key IS NULL OR (parent_id IS NULL AND system_key IN ('all-versions','fnf-showcase'))),
 FOREIGN KEY(owner_id,parent_id) REFERENCES axfluxo_video.media_folders(owner_id,id) ON DELETE RESTRICT
);
CREATE TABLE axfluxo_video.media_assets (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, folder_id uuid, name text NOT NULL,
 deleted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id), FOREIGN KEY(owner_id,folder_id) REFERENCES axfluxo_video.media_folders(owner_id,id) ON DELETE RESTRICT
);
-- Only verified bytes have a version. Incomplete/quarantined candidates live in upload_sessions.
CREATE TABLE axfluxo_video.media_versions (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, asset_id uuid NOT NULL, object_key text NOT NULL UNIQUE,
 hash text NOT NULL CHECK(hash ~ '^[a-f0-9]{64}$'), size bigint NOT NULL CHECK(size>0),
 mime text NOT NULL, kind text NOT NULL CHECK(kind IN ('image','audio','video')), probe jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id), UNIQUE(owner_id,hash),
 FOREIGN KEY(owner_id,asset_id) REFERENCES axfluxo_video.media_assets(owner_id,id) ON DELETE RESTRICT
);
CREATE TABLE axfluxo_video.media_derivatives (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, version_id uuid NOT NULL, object_key text NOT NULL UNIQUE,
 hash text NOT NULL, kind text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_id,version_id) REFERENCES axfluxo_video.media_versions(owner_id,id) ON DELETE RESTRICT
);
CREATE TABLE axfluxo_video.media_quotas (
 owner_id uuid PRIMARY KEY, limit_bytes bigint CHECK(limit_bytes>=0),
 reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0), used_bytes bigint NOT NULL DEFAULT 0 CHECK(used_bytes>=0),
 blocked boolean NOT NULL DEFAULT false,
 CHECK(limit_bytes IS NULL OR reserved_bytes+used_bytes<=limit_bytes)
);
CREATE TABLE axfluxo_video.upload_sessions (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, folder_id uuid, name text NOT NULL,
 size bigint NOT NULL CHECK(size>0), expected_hash text NOT NULL CHECK(expected_hash ~ '^[a-f0-9]{64}$'), declared_mime text NOT NULL,
 object_key text NOT NULL UNIQUE, multipart_id text, part_size bigint NOT NULL, part_count integer NOT NULL CHECK(part_count BETWEEN 1 AND 10000),
 state text NOT NULL CHECK(state IN ('creating','uploading','completing','verifying','ready','failed','aborting','aborted','expired')),
 parts jsonb NOT NULL DEFAULT '{}', lease_token uuid, lease_until timestamptz, error_code text,
 accounted boolean NOT NULL DEFAULT false, asset_id uuid, version_id uuid,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,folder_id) REFERENCES axfluxo_video.media_folders(owner_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_id,asset_id) REFERENCES axfluxo_video.media_assets(owner_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_id,version_id) REFERENCES axfluxo_video.media_versions(owner_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_id) REFERENCES axfluxo_video.media_quotas(owner_id) ON DELETE RESTRICT
);
CREATE INDEX media_asset_cursor ON axfluxo_video.media_assets(owner_id,folder_id,deleted,id);
CREATE INDEX media_probe_pending ON axfluxo_video.upload_sessions(state,lease_until) WHERE state='verifying';
CREATE TRIGGER media_original_immutable BEFORE UPDATE OR DELETE ON axfluxo_video.media_versions FOR EACH ROW EXECUTE FUNCTION axfluxo_video.reject_immutable_change();
CREATE TRIGGER media_derivative_immutable BEFORE UPDATE OR DELETE ON axfluxo_video.media_derivatives FOR EACH ROW EXECUTE FUNCTION axfluxo_video.reject_immutable_change();
CREATE FUNCTION axfluxo_video.upload_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF ROW(NEW.owner_id,NEW.size,NEW.expected_hash,NEW.declared_mime,NEW.object_key,NEW.part_size,NEW.part_count) IS DISTINCT FROM ROW(OLD.owner_id,OLD.size,OLD.expected_hash,OLD.declared_mime,OLD.object_key,OLD.part_size,OLD.part_count) THEN
 RAISE EXCEPTION 'immutable upload identity' USING ERRCODE='55000'; END IF; RETURN NEW; END $$;
CREATE TRIGGER upload_identity_immutable BEFORE UPDATE ON axfluxo_video.upload_sessions FOR EACH ROW EXECUTE FUNCTION axfluxo_video.upload_identity_immutable();
DO $$ DECLARE t text; r text; BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='axfluxo_video_probe') THEN CREATE ROLE axfluxo_video_probe NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname='axfluxo_video_probe' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN RAISE EXCEPTION 'invalid probe role'; END IF;
 GRANT axfluxo_video_api TO axfluxo_video_probe;
 FOREACH t IN ARRAY ARRAY['media_folders','media_assets','media_versions','media_derivatives','media_quotas','upload_sessions'] LOOP
 EXECUTE format('ALTER TABLE axfluxo_video.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE axfluxo_video.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY owner_only ON axfluxo_video.%I TO axfluxo_video_api USING(owner_id=nullif(current_setting(''axfluxo.owner_id'',true),'''')::uuid) WITH CHECK(owner_id=nullif(current_setting(''axfluxo.owner_id'',true),'''')::uuid)',t);
 END LOOP;
 FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
 IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA axfluxo_video FROM %I',r); END IF;
 END LOOP;
END $$;
CREATE POLICY probe_discovery ON axfluxo_video.upload_sessions FOR SELECT TO axfluxo_video_probe USING(true);
REVOKE ALL ON ALL TABLES IN SCHEMA axfluxo_video FROM PUBLIC;
REVOKE ALL ON FUNCTION axfluxo_video.upload_identity_immutable() FROM PUBLIC;
GRANT SELECT ON axfluxo_video.media_folders,axfluxo_video.media_assets,axfluxo_video.media_versions,axfluxo_video.media_derivatives,axfluxo_video.media_quotas,axfluxo_video.upload_sessions TO axfluxo_video_api;
GRANT INSERT ON axfluxo_video.media_folders,axfluxo_video.upload_sessions TO axfluxo_video_api;
GRANT UPDATE(name,parent_id) ON axfluxo_video.media_folders TO axfluxo_video_api;
GRANT UPDATE(name,folder_id,deleted) ON axfluxo_video.media_assets TO axfluxo_video_api;
GRANT UPDATE(reserved_bytes,used_bytes,blocked) ON axfluxo_video.media_quotas TO axfluxo_video_api;
GRANT UPDATE(state,multipart_id,parts,lease_token,lease_until,error_code,accounted,asset_id,version_id) ON axfluxo_video.upload_sessions TO axfluxo_video_api;
GRANT INSERT ON axfluxo_video.media_assets,axfluxo_video.media_versions,axfluxo_video.media_derivatives,axfluxo_video.resource_versions TO axfluxo_video_probe;
COMMIT;
