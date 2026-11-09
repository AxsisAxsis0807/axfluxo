-- Approval required. Only removes this probe's schema in its dedicated DB.
BEGIN;
DO $$ BEGIN
 IF current_database() !~ '^axfluxo[-_]probe[-_][a-z0-9_-]+$' THEN
 RAISE EXCEPTION 'Refusing non-probe database'; END IF;
END $$;
DROP SCHEMA IF EXISTS axfluxo_connection_probe CASCADE;
COMMIT;
