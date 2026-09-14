-- Migration 057: close anonymous access to season_standings and to the
-- unguarded SECURITY DEFINER functions reachable by anon.
--
-- season_standings was readable by anyone holding the publishable key, with no
-- sign-in. Two things combined:
--
--   1. It is a definer-rights view. 001 created it without security_invoker and
--      018 / 019 / 030 / 039 redefined it with plain CREATE OR REPLACE, so it ran
--      as its owner, postgres, which bypasses RLS. The RLS on league_scores,
--      league_rounds, seasons, players and group_members that get-standings and
--      docs/api.md describe as filtering it never applied.
--   2. Supabase's default ACL for schema public grants anon (and authenticated,
--      service_role) every privilege on every new relation and EXECUTE on every
--      new function — DIRECTLY, not via PUBLIC. So anon held SELECT from 001 on.
--
-- Verified 2026-09-14 before this migration: an unauthenticated PostgREST request
-- counted all 178 rows of the view; the same request counted 0 on the base tables.
--
-- VIEW
--   security_invoker = on   The view now runs as the caller, so base-table RLS
--                           applies. This is the structural fix: the view can never
--                           return more than the tables allow, for any role. Every
--                           authenticated SELECT policy on the five base tables is
--                           USING (true), so signed-in results do not change — the
--                           view body run as `authenticated` returned the same 178
--                           rows with the same checksum as the definer view.
--   REVOKE ALL FROM anon    Belt: anon gets permission-denied rather than relying on
--                           RLS to return zero rows, and it fails closed if RLS on a
--                           base table is ever loosened.
--
-- FUNCTIONS (same shape: SECURITY DEFINER + EXECUTE for anon, no auth check inside)
--   ensure_next_season_all_groups(), ensure_next_season_for_group(text)
--       These WRITE (insert seasons). The only caller is the pg_cron job
--       windex-season-rollover-daily, which runs as postgres, the owner. Revoked
--       from PUBLIC as well as anon and authenticated: both kept the default PUBLIC
--       EXECUTE, which anon inherits, so revoking anon alone would change nothing.
--   get_season_points_pops(text)
--       Returns per-season point ranks — a subset of the view leak. Revoked from
--       anon only. Its one caller, replace_finishing_order, is SECURITY DEFINER owned
--       by postgres, so the inner call is checked against postgres. PUBLIC was
--       already revoked in 050; authenticated keeps the EXECUTE 050 granted.
--
-- Why 047 and 050's `REVOKE ALL ... FROM PUBLIC` never closed this: the default ACL
-- grants anon directly, and revoking PUBLIC does not remove a direct grant. Every new
-- view or function in public inherits the same exposure — see BACKLOG.md.
--
-- REDEFINING season_standings — tested 2026-09-14 against production in a
-- rolled-back transaction:
--   CREATE OR REPLACE VIEW ... AS ...
--       RESETS the option. security_invoker is dropped and the view silently becomes
--       definer-rights again. The anon REVOKE survives, so anon stays blocked, but RLS
--       stops applying for every other role.
--   CREATE OR REPLACE VIEW ... WITH (security_invoker = on) AS ...
--       keeps it.
--   DROP VIEW + CREATE VIEW
--       drops the option AND re-applies the default ACL: anon gets SELECT back. The
--       exposure 057 closes returns in full.
-- So every redefinition must be written WITH (security_invoker = on) and must repeat
-- REVOKE ALL ON public.season_standings FROM anon.
--
-- The DO block below runs ONCE, when this migration applies. It proves 057 did what
-- it says; it does not guard any later migration.

ALTER VIEW public.season_standings SET (security_invoker = on);
REVOKE ALL ON public.season_standings FROM anon;

REVOKE EXECUTE ON FUNCTION public.ensure_next_season_all_groups() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.ensure_next_season_for_group(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_season_points_pops(TEXT) FROM anon;

DO $$
BEGIN
  -- What 057 closes.
  IF NOT COALESCE((
       SELECT o.option_value::boolean
         FROM pg_class c, pg_options_to_table(c.reloptions) o
        WHERE c.oid = 'public.season_standings'::regclass
          AND o.option_name = 'security_invoker'), false) THEN
    RAISE EXCEPTION '057: season_standings is not security_invoker';
  END IF;
  IF has_table_privilege('anon', 'public.season_standings',
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION '057: anon still holds a privilege on season_standings';
  END IF;
  IF has_function_privilege('anon', 'public.ensure_next_season_all_groups()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ensure_next_season_all_groups()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.ensure_next_season_for_group(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ensure_next_season_for_group(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '057: a season-rollover function is still executable by anon or authenticated';
  END IF;
  IF has_function_privilege('anon', 'public.get_season_points_pops(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '057: anon can still execute get_season_points_pops';
  END IF;

  -- What must keep working.
  IF NOT has_table_privilege('authenticated', 'public.season_standings', 'SELECT') THEN
    RAISE EXCEPTION '057: authenticated lost SELECT on season_standings';
  END IF;
  IF NOT has_function_privilege('postgres', 'public.ensure_next_season_all_groups()', 'EXECUTE') THEN
    RAISE EXCEPTION '057: postgres (the pg_cron job user) lost EXECUTE on ensure_next_season_all_groups';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_season_points_pops(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '057: authenticated lost EXECUTE on get_season_points_pops';
  END IF;
END $$;
