-- Cloud export retention, owner-initiated deletion and one-time download tickets.
-- Additive only. Requires 008_cloud_export.sql. Apply explicitly as an administrator.
BEGIN;

-- 1. A Safari navigation cannot send an Authorization header. A short-lived,
--    single-use ticket lets the browser download straight to Files instead of
--    buffering the whole MP4 in JS memory. Only the hash of the token is stored.
CREATE TABLE axfluxo_export.download_tickets (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  owner_id uuid NOT NULL,
  job_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '1 hour'),
  FOREIGN KEY (owner_id, job_id) REFERENCES axfluxo_export.jobs(owner_id, id) ON DELETE CASCADE
);
CREATE INDEX export_tickets_owner ON axfluxo_export.download_tickets (owner_id, created_at DESC);

ALTER TABLE axfluxo_export.download_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE axfluxo_export.download_tickets FORCE ROW LEVEL SECURITY;
REVOKE ALL ON axfluxo_export.download_tickets FROM PUBLIC;

-- Redemption has no authenticated owner yet: the API sets the presented hash,
-- and only the row with that hash is visible until it is marked used.
CREATE POLICY ticket_api ON axfluxo_export.download_tickets TO axfluxo_export_api
  USING (token_hash = nullif(current_setting('axfluxo.export_ticket', true), ''))
  WITH CHECK (token_hash = nullif(current_setting('axfluxo.export_ticket', true), ''));
CREATE POLICY owner_api ON axfluxo_export.download_tickets TO axfluxo_export_api
  USING (owner_id = nullif(current_setting('axfluxo.export_owner', true), '')::uuid)
  WITH CHECK (owner_id = nullif(current_setting('axfluxo.export_owner', true), '')::uuid);
CREATE POLICY owner_worker ON axfluxo_export.download_tickets TO axfluxo_export_worker
  USING (owner_id = nullif(current_setting('axfluxo.export_owner', true), '')::uuid)
  WITH CHECK (owner_id = nullif(current_setting('axfluxo.export_owner', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON axfluxo_export.download_tickets TO axfluxo_export_api;
GRANT SELECT, DELETE ON axfluxo_export.download_tickets TO axfluxo_export_worker;

-- 2. Deletion stays impossible unless the transaction explicitly opts in. RLS
--    still limits every statement to rows of the current owner scope.
CREATE OR REPLACE FUNCTION axfluxo_export.guard_blob() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, axfluxo_export AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('axfluxo.export_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
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

CREATE OR REPLACE FUNCTION axfluxo_export.guard_job() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, axfluxo_export AS $$
DECLARE allowed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('axfluxo.export_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
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

-- 3. Purge needs to remove job rows, pins and tickets, and the worker must be able
--    to find expired rows of every owner before it switches to that owner's scope.
GRANT DELETE ON axfluxo_export.jobs, axfluxo_export.job_blobs TO axfluxo_export_api, axfluxo_export_worker;
CREATE POLICY worker_job_retention ON axfluxo_export.jobs FOR SELECT TO axfluxo_export_worker
  USING (state IN ('succeeded', 'failed', 'cancelled'));
CREATE POLICY worker_blob_discovery ON axfluxo_export.blobs FOR SELECT TO axfluxo_export_worker
  USING (true);
CREATE INDEX export_jobs_retention ON axfluxo_export.jobs (coalesce(finished_at, created_at))
  WHERE state IN ('succeeded', 'failed', 'cancelled');
CREATE INDEX export_blobs_pending ON axfluxo_export.blobs (created_at) WHERE state = 'pending';

COMMIT;
