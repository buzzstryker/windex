-- Migration 048: bound season auto-rollover to ONE season ahead of today.
--
-- The bug (migration 021): ensure_next_season_for_group() anchors v_recent_end
-- on the MOST-FUTURE season (ORDER BY end_date DESC LIMIT 1, 021:143-148), then
-- computes v_next_start = v_recent_end + 1 day and only skips if a season
-- already starts on that exact date (021:159-168). Because the anchor advances
-- every time a future row is added, v_next_start is always one year beyond the
-- furthest existing season — a date no row starts on — so the guard never
-- blocks. The daily windex-season-rollover-daily cron (021:252-256) therefore
-- creates one new future season per group per run. Observed ~40 future rows per
-- group, out to 2065, growing by one/group/day.
--
-- The fix: before inserting, bail out if the group already has any season whose
-- start_date is in the future. That keeps at most one season ahead of today —
-- the intended invariant — while leaving the anchor/date math (and the SECURITY
-- DEFINER signature, search_path, and the cron wrapper that calls this) exactly
-- as in 021. The original exact-start-date idempotency check is kept; it is now
-- redundant but harmless.
--
-- SCOPE: function only. This migration does NOT delete the ~78 already-projected
-- surplus rows — it only stops new ones accruing. The shipped UI filters
-- (windex-admin CupChampions coming-season cutoff; windex-expo listSeasons
-- future filter) already hide them. The one-time cleanup DELETE is deferred to a
-- separate migration (049) pending visual review of the exact delete set, per
-- the migration-discipline note in BACKLOG.md (destructive writes go through a
-- reviewed db push, never dashboard/MCP).

CREATE OR REPLACE FUNCTION public.ensure_next_season_for_group(p_group_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ssm        INT;
  v_recent_end DATE;
  v_next_start DATE;
  v_next_end   DATE;
  v_new_id     TEXT;
  v_existing   INT;
BEGIN
  -- Read the schedule hint
  SELECT season_start_month INTO v_ssm FROM public.groups WHERE id = p_group_id;
  IF v_ssm IS NULL THEN
    RAISE NOTICE 'ensure_next_season_for_group(%): group not found', p_group_id;
    RETURN NULL;
  END IF;
  IF v_ssm = 0 THEN
    RAISE NOTICE 'ensure_next_season_for_group(%): season_start_month=0 (no schedule), skipping', p_group_id;
    RETURN NULL;
  END IF;

  -- Keep at most ONE season ahead of today: if a future season already exists
  -- for this group, there is nothing to project. This is the guard that bounds
  -- the rollover (added in migration 048); without it the anchor below marches
  -- forward one year per run. start_date is stored as YYYY-MM-DD TEXT, so a
  -- lexical compare against today is also chronological.
  IF EXISTS (
    SELECT 1 FROM public.seasons
     WHERE group_id = p_group_id
       AND start_date > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
  ) THEN
    RAISE NOTICE 'ensure_next_season_for_group(%): a future season already exists, skipping', p_group_id;
    RETURN NULL;
  END IF;

  -- Most recent season's end_date for this group
  SELECT end_date::date INTO v_recent_end
    FROM public.seasons
   WHERE group_id = p_group_id
   ORDER BY end_date DESC
   LIMIT 1;

  IF v_recent_end IS NULL THEN
    RAISE NOTICE 'ensure_next_season_for_group(%): no seed season — bootstrap via the Create Season UI', p_group_id;
    RETURN NULL;
  END IF;

  -- Compute next window: day after previous end, length one calendar year - 1 day
  v_next_start := v_recent_end + INTERVAL '1 day';
  v_next_end   := (v_next_start + INTERVAL '1 year' - INTERVAL '1 day')::date;

  -- Idempotency: skip if a season already starts on v_next_start
  SELECT COUNT(*) INTO v_existing
    FROM public.seasons
   WHERE group_id = p_group_id
     AND start_date = to_char(v_next_start, 'YYYY-MM-DD');

  IF v_existing > 0 THEN
    RAISE NOTICE 'ensure_next_season_for_group(%): season starting % already exists, skipping', p_group_id, v_next_start;
    RETURN NULL;
  END IF;

  -- Deterministic id: sanitize group_id and append the calendar-year of end.
  -- Using the sn_<group_id>_<endYear> pattern explicitly authorized in the
  -- spec; ON CONFLICT(id) handling unnecessary because the (group_id,
  -- start_date) pre-check above already guarantees uniqueness for this flow.
  v_new_id := 'sn_' ||
              regexp_replace(p_group_id, '[^a-zA-Z0-9_-]', '_', 'g') ||
              '_' || EXTRACT(YEAR FROM v_next_end)::text;

  INSERT INTO public.seasons (id, group_id, start_date, end_date, created_at, updated_at)
  VALUES (
    v_new_id,
    p_group_id,
    to_char(v_next_start, 'YYYY-MM-DD'),
    to_char(v_next_end, 'YYYY-MM-DD'),
    now(),
    now()
  );

  RAISE NOTICE 'ensure_next_season_for_group(%): created % (% to %)',
    p_group_id, v_new_id, v_next_start, v_next_end;
  RETURN v_new_id;
END;
$$;

COMMENT ON FUNCTION public.ensure_next_season_for_group(TEXT) IS
  'Idempotently ensure the next season exists for a group, bounded to one season ahead of today (migration 048 added the future-exists guard). Returns new season id or NULL.';
