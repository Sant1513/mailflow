-- Lock Supabase's auto-generated REST API (PostgREST) out of MailFlow's tables.
-- MailFlow never uses that API: the app connects directly as the table owner, which Row-Level
-- Security does not restrict, and file storage uses the service key. Supabase's security advisor
-- flagged every table as readable and writable by the public `anon`/`authenticated` roles.
--   1. RLS on for every table in public (no policies = the API roles see nothing).
--   2. The API roles lose their table and sequence privileges, now and for tables created later.
-- Safe on the laptop's own Postgres too: RLS is a no-op for the owner, and the role steps only run
-- where Supabase's roles exist.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
  END IF;
END $$;
