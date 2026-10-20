-- Migration 058: seasons.closed_at — explicit season closure marker.
--
-- NULL = open. Set and cleared ONLY by close_season() / reopen_season()
-- (migration 060), which also write / delete the frozen standings snapshot in
-- season_standings_final (059) in the same transaction.
--
-- seasons_update RLS (015) lets group admins PATCH seasons, so a guard trigger
-- blocks every other path from touching closed_at. The RPCs open the guard with
-- the transaction-local setting windex.season_closure = 'on'. PostgREST cannot
-- set arbitrary settings, so only SQL functions can open it — never call
-- set_config('windex.season_closure', …) outside migration 060.

ALTER TABLE public.seasons
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN public.seasons.closed_at IS
  'When the season''s standings were frozen into season_standings_final. NULL = open. Written only by close_season() / reopen_season().';

CREATE OR REPLACE FUNCTION public.guard_seasons_closed_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(current_setting('windex.season_closure', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'seasons.closed_at cannot be set on insert; use close_season()'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
    RAISE EXCEPTION 'seasons.closed_at can only be changed by close_season() or reopen_season()'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger functions are not callable as RPCs, but keep the default-ACL grant
-- (anon + authenticated, see 057) off it anyway.
REVOKE ALL ON FUNCTION public.guard_seasons_closed_at() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER seasons_guard_closed_at
  BEFORE INSERT OR UPDATE OF closed_at ON public.seasons
  FOR EACH ROW EXECUTE FUNCTION public.guard_seasons_closed_at();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'seasons'
                    AND column_name = 'closed_at') THEN
    RAISE EXCEPTION '058: seasons.closed_at missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.seasons WHERE closed_at IS NOT NULL) THEN
    RAISE EXCEPTION '058: closed_at must start NULL on every season';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.seasons'::regclass
                    AND tgname = 'seasons_guard_closed_at'
                    AND NOT tgisinternal) THEN
    RAISE EXCEPTION '058: seasons_guard_closed_at trigger missing';
  END IF;
END $$;
