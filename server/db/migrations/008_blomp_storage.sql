BEGIN;
-- A trusted operator provisions a location snapshot. The API cannot change its limits.
CREATE TABLE axfluxo_video.blomp_capacity (
 location text PRIMARY KEY,
 capacity bigint NOT NULL CHECK(capacity BETWEEN 1 AND 9007199254740991),
 measured_used bigint NOT NULL CHECK(measured_used BETWEEN 0 AND capacity),
 margin bigint NOT NULL CHECK(margin BETWEEN 0 AND capacity),
 reserved bigint NOT NULL DEFAULT 0 CHECK(reserved >= 0),
 committed bigint NOT NULL DEFAULT 0 CHECK(committed >= 0),
 upload_remaining bigint NOT NULL DEFAULT 0 CHECK(upload_remaining >= 0),
 download_remaining bigint NOT NULL DEFAULT 0 CHECK(download_remaining >= 0),
 verification_remaining bigint NOT NULL CHECK(verification_remaining >= 0),
 observed_at timestamptz NOT NULL
);
CREATE TABLE axfluxo_video.blomp_files (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, provider text NOT NULL DEFAULT 'blomp' CHECK(provider='blomp'),
 location text NOT NULL REFERENCES axfluxo_video.blomp_capacity(location),
 object_key text NOT NULL UNIQUE, role text NOT NULL CHECK(role IN ('originals','outputs')),
 name text NOT NULL, mime text NOT NULL, size bigint NOT NULL CHECK(size BETWEEN 1 AND 5368709120),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 project_id uuid, job_id uuid, version int NOT NULL DEFAULT 1 CHECK(version=1),
 request_key uuid NOT NULL, UNIQUE(owner_id,request_key),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','creating','uploading','interrupted','completing','verifying','ready','failed','aborting','cancelled')),
 upload_id text, lease uuid, lease_until timestamptz, signed_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day',
 FOREIGN KEY(owner_id,project_id) REFERENCES axfluxo_video.video_projects(owner_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(owner_id,job_id) REFERENCES axfluxo_video.render_jobs(owner_id,id) ON DELETE RESTRICT
);
CREATE INDEX blomp_owner_location ON axfluxo_video.blomp_files(owner_id,location,id);
CREATE TABLE axfluxo_video.blomp_requests (
 owner_id uuid PRIMARY KEY, window_start timestamptz NOT NULL, count int NOT NULL
);
ALTER TABLE axfluxo_video.blomp_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE axfluxo_video.blomp_files FORCE ROW LEVEL SECURITY;
ALTER TABLE axfluxo_video.blomp_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE axfluxo_video.blomp_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON axfluxo_video.blomp_files TO axfluxo_video_api
 USING(owner_id=nullif(current_setting('axfluxo.owner_id',true),'')::uuid);
CREATE POLICY owner_only ON axfluxo_video.blomp_requests TO axfluxo_video_api
 USING(owner_id=nullif(current_setting('axfluxo.owner_id',true),'')::uuid);
REVOKE ALL ON axfluxo_video.blomp_capacity,axfluxo_video.blomp_files,axfluxo_video.blomp_requests FROM PUBLIC;
GRANT SELECT ON axfluxo_video.blomp_capacity TO axfluxo_video_api;
GRANT UPDATE(reserved,committed,upload_remaining,download_remaining,verification_remaining) ON axfluxo_video.blomp_capacity TO axfluxo_video_api;
GRANT SELECT,INSERT ON axfluxo_video.blomp_files,axfluxo_video.blomp_requests TO axfluxo_video_api;
GRANT UPDATE(status,upload_id,lease,lease_until,signed_until,updated_at) ON axfluxo_video.blomp_files TO axfluxo_video_api;
GRANT UPDATE(window_start,count) ON axfluxo_video.blomp_requests TO axfluxo_video_api;
COMMIT;
