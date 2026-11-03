-- Run in the existing Supabase project's SQL Editor as its database administrator.
-- Independent of the optional video server/database. No existing tables change.
BEGIN;
CREATE SCHEMA IF NOT EXISTS axfluxo_access;
REVOKE ALL ON SCHEMA axfluxo_access FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS axfluxo_access.developer_memberships (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE axfluxo_access.developer_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON axfluxo_access.developer_memberships FROM PUBLIC, anon, authenticated;

-- No user ID / role parameter. Supabase verifies the JWT; auth.uid() is the caller.
-- This read-only function exposes only the caller's current entitlement.
CREATE OR REPLACE FUNCTION public.axfluxo_developer_access()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'ownerId', m.user_id,
    'membership', 'developer',
    'validUntil', LEAST(COALESCE(m.expires_at, now() + interval '60 seconds'), now() + interval '60 seconds')
  )
  FROM axfluxo_access.developer_memberships AS m
  WHERE m.user_id = auth.uid() AND m.active
    AND (m.expires_at IS NULL OR m.expires_at > now());
$$;
REVOKE ALL ON FUNCTION public.axfluxo_developer_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.axfluxo_developer_access() TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
