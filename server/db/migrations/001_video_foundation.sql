-- Additive, private schema. Apply only via an explicitly authorized admin workflow.
BEGIN;
CREATE SCHEMA axfluxo_video;
REVOKE ALL ON SCHEMA axfluxo_video FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'axfluxo_video_api') THEN
    CREATE ROLE axfluxo_video_api NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'axfluxo_video_api' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'axfluxo_video_api must be a non-login, non-privileged role';
  END IF;
END $$;

CREATE TABLE axfluxo_video.developer_memberships (
  owner_id uuid PRIMARY KEY,
  active boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Private, authoritative catalogue. No browser/API write permission. Originals remain immutable.
CREATE TABLE axfluxo_video.resource_versions (
  owner_id uuid NOT NULL,
  library_id text NOT NULL,
  file_id text NOT NULL,
  version_id text NOT NULL,
  hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('video', 'audio', 'image')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, library_id, file_id, version_id),
  UNIQUE (library_id, file_id, version_id),
  UNIQUE (owner_id, library_id, file_id, version_id, hash, kind)
);
CREATE TABLE axfluxo_video.usage_budgets (
  owner_id uuid PRIMARY KEY,
  limit_units bigint CHECK (limit_units >= 0),
  reserved_units bigint NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  consumed_units bigint NOT NULL DEFAULT 0 CHECK (consumed_units >= 0),
  CHECK (limit_units IS NULL OR reserved_units + consumed_units <= limit_units)
);
CREATE TABLE axfluxo_video.render_batches (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id)
);
CREATE TABLE axfluxo_video.render_jobs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  range_index integer NOT NULL CHECK (range_index >= 0),
  attempt integer NOT NULL CHECK (attempt > 0),
  retry_of uuid,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'held', 'running', 'failed', 'succeeded', 'cancel_requested', 'cancelled', 'interrupted')),
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, batch_id, range_index, attempt),
  UNIQUE (owner_id, retry_of),
  FOREIGN KEY (owner_id, batch_id) REFERENCES axfluxo_video.render_batches(owner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_id, retry_of) REFERENCES axfluxo_video.render_jobs(owner_id, id) ON DELETE RESTRICT
);
CREATE TABLE axfluxo_video.render_outputs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  job_id uuid NOT NULL,
  library_id text NOT NULL,
  file_id text NOT NULL,
  version_id text NOT NULL,
  hash text NOT NULL,
  kind text NOT NULL DEFAULT 'video' CHECK (kind = 'video'),
  frame_count bigint NOT NULL CHECK (frame_count > 0),
  fps integer NOT NULL CHECK (fps = 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, id),
  UNIQUE (owner_id, job_id),
  FOREIGN KEY (owner_id, job_id) REFERENCES axfluxo_video.render_jobs(owner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_id, library_id, file_id, version_id, hash, kind) REFERENCES axfluxo_video.resource_versions(owner_id, library_id, file_id, version_id, hash, kind) ON DELETE RESTRICT
);
CREATE TABLE axfluxo_video.resource_pins (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  job_id uuid NOT NULL,
  library_id text NOT NULL,
  file_id text NOT NULL,
  version_id text NOT NULL,
  hash text NOT NULL,
  kind text NOT NULL,
  UNIQUE (owner_id, job_id, library_id, file_id, version_id),
  FOREIGN KEY (owner_id, job_id) REFERENCES axfluxo_video.render_jobs(owner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_id, library_id, file_id, version_id, hash, kind) REFERENCES axfluxo_video.resource_versions(owner_id, library_id, file_id, version_id, hash, kind) ON DELETE RESTRICT
);
CREATE TABLE axfluxo_video.outbox_events (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  job_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('render.requested', 'cancel.requested')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'delivered')),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, job_id, event_type),
  FOREIGN KEY (owner_id, job_id) REFERENCES axfluxo_video.render_jobs(owner_id, id) ON DELETE RESTRICT
);
CREATE INDEX outbox_pending ON axfluxo_video.outbox_events (available_at) WHERE state = 'pending';
CREATE TABLE axfluxo_video.usage_reservations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  job_id uuid NOT NULL,
  units bigint NOT NULL CHECK (units > 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'consumed', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, job_id),
  FOREIGN KEY (owner_id) REFERENCES axfluxo_video.usage_budgets(owner_id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_id, job_id) REFERENCES axfluxo_video.render_jobs(owner_id, id) ON DELETE RESTRICT
);
CREATE TABLE axfluxo_video.audit_events (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('batch.created', 'job.retried', 'job.cancel_requested')),
  batch_id uuid NOT NULL,
  job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_id, batch_id) REFERENCES axfluxo_video.render_batches(owner_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (owner_id, job_id) REFERENCES axfluxo_video.render_jobs(owner_id, id) ON DELETE RESTRICT
);
-- One namespace across all mutating endpoints, not just across batch submissions.
CREATE TABLE axfluxo_video.idempotency_requests (
  owner_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response jsonb,
  response_status integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, idempotency_key),
  CHECK ((response IS NULL) = (response_status IS NULL))
);

CREATE FUNCTION axfluxo_video.reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable video record' USING ERRCODE = '55000'; END $$;
CREATE TRIGGER original_immutable BEFORE UPDATE OR DELETE ON axfluxo_video.resource_versions
  FOR EACH ROW EXECUTE FUNCTION axfluxo_video.reject_immutable_change();
CREATE TRIGGER output_immutable BEFORE UPDATE OR DELETE ON axfluxo_video.render_outputs
  FOR EACH ROW EXECUTE FUNCTION axfluxo_video.reject_immutable_change();
CREATE TRIGGER batch_snapshot_immutable BEFORE UPDATE OR DELETE ON axfluxo_video.render_batches
  FOR EACH ROW EXECUTE FUNCTION axfluxo_video.reject_immutable_change();

DO $$ DECLARE t text; r text; BEGIN
  FOREACH t IN ARRAY ARRAY['developer_memberships','resource_versions','usage_budgets','render_batches','render_jobs','render_outputs','resource_pins','outbox_events','usage_reservations','audit_events','idempotency_requests'] LOOP
    EXECUTE format('ALTER TABLE axfluxo_video.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE axfluxo_video.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_only ON axfluxo_video.%I TO axfluxo_video_api USING (owner_id = nullif(current_setting(''axfluxo.owner_id'', true), '''')::uuid) WITH CHECK (owner_id = nullif(current_setting(''axfluxo.owner_id'', true), '''')::uuid)', t);
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA axfluxo_video FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA axfluxo_video FROM %I', r);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA axfluxo_video FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA axfluxo_video FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA axfluxo_video REVOKE ALL ON TABLES FROM PUBLIC;
GRANT USAGE ON SCHEMA axfluxo_video TO axfluxo_video_api;
GRANT SELECT ON ALL TABLES IN SCHEMA axfluxo_video TO axfluxo_video_api;
GRANT INSERT ON axfluxo_video.render_batches, axfluxo_video.render_jobs, axfluxo_video.resource_pins,
  axfluxo_video.outbox_events, axfluxo_video.usage_reservations, axfluxo_video.audit_events,
  axfluxo_video.idempotency_requests TO axfluxo_video_api;
GRANT UPDATE (reserved_units) ON axfluxo_video.usage_budgets TO axfluxo_video_api;
GRANT UPDATE (state, cancel_requested_at) ON axfluxo_video.render_jobs TO axfluxo_video_api;
GRANT UPDATE (response, response_status) ON axfluxo_video.idempotency_requests TO axfluxo_video_api;
-- Row locking requires UPDATE privilege on at least one column. Never grant active/limit mutations.
GRANT UPDATE (created_at) ON axfluxo_video.developer_memberships TO axfluxo_video_api;
COMMIT;
