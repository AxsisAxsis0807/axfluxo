-- ONLY in a newly created, dedicated test database. Not migration 001–008.
BEGIN;
DO $$ BEGIN
 IF current_database() !~ '^axfluxo[-_]probe[-_][a-z0-9_-]+$' THEN
 RAISE EXCEPTION 'Refusing non-probe database'; END IF;
END $$;
CREATE SCHEMA axfluxo_connection_probe;
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
COMMIT;
-- Prefer applying as the dedicated probe login, owner of only this new DB/schema.
-- If an administrator applies this, grant schema/table privileges only to the
-- dedicated probe login in the settings console, never to PUBLIC or the main app.
