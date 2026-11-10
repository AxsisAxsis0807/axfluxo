CREATE SCHEMA axfluxo_connection_probe;
COMMENT ON SCHEMA axfluxo_connection_probe IS 'axfluxo-probe-v2';
REVOKE ALL ON SCHEMA axfluxo_connection_probe FROM PUBLIC;
CREATE TABLE axfluxo_connection_probe.runs (
 id uuid PRIMARY KEY, expires_at timestamptz NOT NULL,
 api_hash text NOT NULL CHECK(api_hash ~ '^[a-f0-9]{64}$'),
 worker_hash text CHECK(worker_hash ~ '^[a-f0-9]{64}$'), worker_saw_api boolean,
 armed_at timestamptz, window_end timestamptz
);
CREATE TABLE axfluxo_connection_probe.events (
 run_id uuid NOT NULL REFERENCES axfluxo_connection_probe.runs(id),
 kind text NOT NULL CHECK(kind IN ('boot','db-window')),
 slot integer NOT NULL CHECK(slot>=0 AND slot<18), worker_boot uuid NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(), detail jsonb NOT NULL,
 PRIMARY KEY(run_id,kind,slot)
);
REVOKE ALL ON ALL TABLES IN SCHEMA axfluxo_connection_probe FROM PUBLIC;
CREATE TABLE axfluxo_connection_probe.session (
 singleton boolean PRIMARY KEY CHECK(singleton), run_id uuid NOT NULL,
 started_at timestamptz, expires_at timestamptz,
 http_attempts integer NOT NULL DEFAULT 0 CHECK(http_attempts BETWEEN 0 AND 3),
 CHECK ((started_at IS NULL AND expires_at IS NULL) OR
 (expires_at = started_at + interval '30 minutes'))
);
REVOKE ALL ON axfluxo_connection_probe.session FROM PUBLIC;
