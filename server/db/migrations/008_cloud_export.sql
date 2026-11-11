-- Minimal cloud export (All Versions 1:1) storage, queue and lease.
-- Additive only. Requires 001_video_foundation.sql (developer membership catalogue).
-- Apply explicitly as an administrator; services never migrate on startup.
BEGIN;

CREATE SCHEMA IF NOT EXISTS axfluxo_export;
REVOKE ALL ON SCHEMA axfluxo_export FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['axfluxo_export_api','axfluxo_export_worker'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS', r);
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
      EXECUTE format('RAISE EXCEPTION ''%s must be a non-login, non-privileged role''', r);
    END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA axfluxo_export TO %I', r);
  END LOOP;
END $$;

-- Bytes live in this database so the API and an independent worker need no shared disk.
CREATE TABLE axfluxo_export.blobs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('video', 'image', 'output')),
  size bigint NOT NULL CHECK (size > 0 AND size <= 268435456),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  chunk_size integer NOT NULL CHECK (chunk_size BETWEEN 65536 AND 4194304),
  chunk_count integer NOT NULL CHECK (chunk_count BETWEEN 1 AND 4096),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ready')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, sha256, kind, size),
  CHECK (chunk_size::bigint * (chunk_count - 1) < size),
  CHECK (chunk_size::bigint * chunk_count >= size)
);

CREATE TABLE axfluxo_export.blob_chunks (
  blob_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 4194304),
  data bytea NOT NULL,
  PRIMARY KEY (blob_id, ordinal),
  FOREIGN KEY (blob_id) REFERENCES axfluxo_export.blobs(id) ON DELETE CASCADE,
  CHECK (octet_length(data) = byte_length)
);

CREATE TABLE axfluxo_export.jobs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  spec jsonb NOT NULL,
  spec_hash text NOT NULL CHECK (spec_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled')),
  progress_frame bigint NOT NULL DEFAULT 0 CHECK (progress_frame >= 0),
  total_frames bigint NOT NULL CHECK (total_frames > 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
  error_code text,
  output_blob_id uuid,
  output_validation jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, idempotency_key),
  FOREIGN KEY (owner_id, output_blob_id) REFERENCES axfluxo_export.blobs(owner_id, id) ON DELETE RESTRICT
);
CREATE INDEX export_jobs_queue ON axfluxo_export.jobs (created_at, id) WHERE state = 'queued';
CREATE INDEX export_jobs_owner ON axfluxo_export.jobs (owner_id, created_at DESC);

-- Inputs pinned to a job. A future delete/GC must consult this table.
CREATE TABLE axfluxo_export.job_blobs (
  job_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  blob_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('clip', 'cover')),
  PRIMARY KEY (job_id, blob_id, role),
  UNIQUE (owner_id, job_id, blob_id, role),
  FOREIGN KEY (job_id) REFERENCES axfluxo_export.jobs(id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_id, blob_id) REFERENCES axfluxo_export.blobs(owner_id, id) ON DELETE RESTRICT
);

-- Exactly one concurrent FFmpeg execution across all workers of this database.
CREATE TABLE axfluxo_export.slot (
  id integer PRIMARY KEY CHECK (id = 1),
  token bigint NOT NULL DEFAULT 0,
  owner_id uuid,
  job_id uuid,
  lease_until timestamptz,
  CHECK ((job_id IS NULL) = (lease_until IS NULL)),
  CHECK ((job_id IS NULL) = (owner_id IS NULL))
);
INSERT INTO axfluxo_export.slot (id) VALUES (1);

-- Write-once semantics for blob bytes and a documented state machine for jobs.
CREATE FUNCTION axfluxo_export.guard_chunk() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, axfluxo_export AS $$
DECLARE s text;
BEGIN
  SELECT state INTO s FROM axfluxo_export.blobs WHERE id = NEW.blob_id;
  IF s IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'immutable export blob' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER export_chunk_write_once BEFORE INSERT ON axfluxo_export.blob_chunks
  FOR EACH ROW EXECUTE FUNCTION axfluxo_export.guard_chunk();

CREATE FUNCTION axfluxo_export.guard_blob() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, axfluxo_export AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state = 'ready' THEN
      RAISE EXCEPTION 'immutable export blob' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.kind <> OLD.kind OR NEW.size <> OLD.size OR NEW.sha256 <> OLD.sha256
     OR NEW.owner_id <> OLD.owner_id OR NEW.chunk_size <> OLD.chunk_size
     OR NEW.chunk_count <> OLD.chunk_count OR OLD.state = 'ready' OR NEW.state <> 'ready' THEN
    RAISE EXCEPTION 'immutable export blob' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER export_blob_finalize BEFORE UPDATE OR DELETE ON axfluxo_export.blobs
  FOR EACH ROW EXECUTE FUNCTION axfluxo_export.guard_blob();

CREATE FUNCTION axfluxo_export.guard_job() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, axfluxo_export AS $$
DECLARE allowed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'export job history is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.owner_id <> OLD.owner_id OR NEW.spec_hash <> OLD.spec_hash
     OR NEW.total_frames <> OLD.total_frames THEN
    RAISE EXCEPTION 'export job identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;
  allowed := (OLD.state, NEW.state) IN (
    ('queued', 'running'), ('queued', 'cancelled'), ('queued', 'failed'),
    ('running', 'queued'),
    ('running', 'succeeded'), ('running', 'failed'), ('running', 'cancel_requested'),
    ('cancel_requested', 'cancelled'), ('cancel_requested', 'failed')
  );
  IF NOT allowed THEN
    RAISE EXCEPTION 'invalid export job transition % -> %', OLD.state, NEW.state USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER export_job_transition BEFORE UPDATE OR DELETE ON axfluxo_export.jobs
  FOR EACH ROW EXECUTE FUNCTION axfluxo_export.guard_job();

-- Owner isolation is enforced by row security in addition to explicit owner predicates.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['blobs', 'jobs', 'job_blobs'] LOOP
    EXECUTE format('ALTER TABLE axfluxo_export.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE axfluxo_export.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_api ON axfluxo_export.%I TO axfluxo_export_api USING (owner_id = nullif(current_setting(''axfluxo.export_owner'', true), '''')::uuid) WITH CHECK (owner_id = nullif(current_setting(''axfluxo.export_owner'', true), '''')::uuid)', t);
    EXECUTE format('CREATE POLICY owner_worker ON axfluxo_export.%I TO axfluxo_export_worker USING (owner_id = nullif(current_setting(''axfluxo.export_owner'', true), '''')::uuid) WITH CHECK (owner_id = nullif(current_setting(''axfluxo.export_owner'', true), '''')::uuid)', t);
    EXECUTE format('REVOKE ALL ON axfluxo_export.%I FROM PUBLIC', t);
  END LOOP;
  -- chunk rows carry no owner column; resolve it through the blob row.
  ALTER TABLE axfluxo_export.blob_chunks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE axfluxo_export.blob_chunks FORCE ROW LEVEL SECURITY;
  REVOKE ALL ON axfluxo_export.blob_chunks FROM PUBLIC;
  CREATE POLICY owner_api ON axfluxo_export.blob_chunks TO axfluxo_export_api
    USING (EXISTS (SELECT 1 FROM axfluxo_export.blobs b WHERE b.id = blob_id AND b.owner_id = nullif(current_setting('axfluxo.export_owner', true), '')::uuid))
    WITH CHECK (EXISTS (SELECT 1 FROM axfluxo_export.blobs b WHERE b.id = blob_id AND b.owner_id = nullif(current_setting('axfluxo.export_owner', true), '')::uuid));
  CREATE POLICY owner_worker ON axfluxo_export.blob_chunks TO axfluxo_export_worker
    USING (EXISTS (SELECT 1 FROM axfluxo_export.blobs b WHERE b.id = blob_id AND b.owner_id = nullif(current_setting('axfluxo.export_owner', true), '')::uuid))
    WITH CHECK (EXISTS (SELECT 1 FROM axfluxo_export.blobs b WHERE b.id = blob_id AND b.owner_id = nullif(current_setting('axfluxo.export_owner', true), '')::uuid));
END $$;

-- The worker may discover queued jobs of any owner, then switches its scope to that owner.
CREATE POLICY worker_job_discovery ON axfluxo_export.jobs FOR SELECT TO axfluxo_export_worker USING (true);
-- Membership is the existing authoritative developer catalogue, not a new declaration.
CREATE POLICY export_membership ON axfluxo_video.developer_memberships TO axfluxo_export_api
  USING (owner_id = nullif(current_setting('axfluxo.export_owner', true), '')::uuid);
GRANT USAGE ON SCHEMA axfluxo_video TO axfluxo_export_api, axfluxo_export_worker;
GRANT SELECT ON axfluxo_video.developer_memberships TO axfluxo_export_api, axfluxo_export_worker;
GRANT UPDATE (created_at) ON axfluxo_video.developer_memberships TO axfluxo_export_api, axfluxo_export_worker;
CREATE POLICY export_membership_worker ON axfluxo_video.developer_memberships TO axfluxo_export_worker
  USING (owner_id = nullif(current_setting('axfluxo.export_owner', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON axfluxo_export.blobs TO axfluxo_export_api, axfluxo_export_worker;
GRANT SELECT, INSERT, DELETE ON axfluxo_export.blob_chunks TO axfluxo_export_api, axfluxo_export_worker;
GRANT SELECT, INSERT, UPDATE ON axfluxo_export.jobs TO axfluxo_export_api, axfluxo_export_worker;
GRANT SELECT, INSERT ON axfluxo_export.job_blobs TO axfluxo_export_api, axfluxo_export_worker;
GRANT SELECT, UPDATE ON axfluxo_export.slot TO axfluxo_export_worker;

COMMIT;
