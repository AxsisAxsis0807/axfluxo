-- Additive and manual only. No Drive resources are deleted by this migration.
BEGIN;
CREATE TABLE axfluxo_video.drive_connections (
 owner_id uuid PRIMARY KEY REFERENCES axfluxo_video.developer_memberships(owner_id),
 generation uuid NOT NULL,
 refresh_cipher text,
 root_id text, queue_id text, completed_id text,
 account_id text,
 connected boolean NOT NULL DEFAULT false
);
CREATE TABLE axfluxo_video.drive_oauth (
 state_hash text PRIMARY KEY,
 owner_id uuid NOT NULL REFERENCES axfluxo_video.drive_connections(owner_id),
 generation uuid NOT NULL,
 verifier_cipher text NOT NULL,
 binding_hash text,
 started boolean NOT NULL DEFAULT false,
 used boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE TABLE axfluxo_video.drive_files (
 owner_id uuid NOT NULL REFERENCES axfluxo_video.drive_connections(owner_id),
 operation_id uuid NOT NULL,
 file_id text NOT NULL,
 account_id text NOT NULL,
 size integer NOT NULL CHECK(size BETWEEN 0 AND 262144),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 ready boolean NOT NULL DEFAULT false,
 PRIMARY KEY(owner_id,operation_id), UNIQUE(owner_id,file_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['drive_connections','drive_oauth','drive_files'] LOOP
 EXECUTE format('ALTER TABLE axfluxo_video.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('ALTER TABLE axfluxo_video.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON axfluxo_video.%I FROM PUBLIC',t);
 EXECUTE format('CREATE POLICY owner_api ON axfluxo_video.%I TO axfluxo_video_api USING(owner_id=nullif(current_setting(''axfluxo.owner_id'',true),'''')::uuid) WITH CHECK(owner_id=nullif(current_setting(''axfluxo.owner_id'',true),'''')::uuid)',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON axfluxo_video.%I TO axfluxo_video_api',t);
 END LOOP;
END $$;
-- Only a 256-bit presented state hash may discover the callback's owner.
CREATE POLICY oauth_redemption ON axfluxo_video.drive_oauth TO axfluxo_video_api
 USING(state_hash=nullif(current_setting('axfluxo.drive_state',true),'') AND expires_at>now() AND NOT used)
 WITH CHECK(state_hash=nullif(current_setting('axfluxo.drive_state',true),''));
COMMIT;
