-- Approval required. Only removes this probe's schema in its dedicated DB.

DO $$ BEGIN
 IF current_database() IS DISTINCT FROM current_setting('probe.expected_database',true) THEN
 RAISE EXCEPTION 'Refusing non-probe database'; END IF;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='axfluxo_connection_probe'
 AND pg_get_userbyid(nspowner)=current_user AND obj_description(oid,'pg_namespace')='axfluxo-probe-v2') THEN
 RAISE EXCEPTION 'Unverified probe schema'; END IF;
END $$;
DROP SCHEMA IF EXISTS axfluxo_connection_probe CASCADE;
