-- 052_group_type.sql
-- Adds a group_type discriminator to groups:
--   'league' — a playing group; visible to players everywhere groups appear.
--   'roster' — a prospect pool (e.g. YC Wednesday Mens Game); hidden from
--              players, browsable by super-admins as an add source in the PWA.
-- Also flags YC Wednesday Mens Game as the first roster, and guards the season
-- rollover so the daily cron never mints seasons on a roster.
--
-- Additive and safe to apply ahead of any app deploy: DEFAULT 'league' leaves
-- every existing group unchanged in behavior; apps that don't yet read the
-- column simply see every group as a league.

-- 1. The column ---------------------------------------------------------------
ALTER TABLE public.groups
  ADD COLUMN group_type text NOT NULL DEFAULT 'league'
  CHECK (group_type IN ('league', 'roster'));

-- 2. Flag the first roster ----------------------------------------------------
UPDATE public.groups SET group_type = 'roster'
 WHERE id = 'SFrbUMKGvbqmCBTVHjHc'; -- YC Wednesday Mens Game

-- 3. Roster-guard the season rollover -----------------------------------------
-- Reproduces the live function bodies verbatim (021 wrapper; 048 predicate fix)
-- with ONLY a roster guard added. The wrapper skips rosters in its loop; the
-- per-group function additionally no-ops for a roster so a future direct caller
-- can't seed one either (belt-and-suspenders).

CREATE OR REPLACE FUNCTION public.ensure_next_season_for_group(p_group_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ssm        INT;
  v_gtype      TEXT;
  v_recent_end DATE;
  v_next_start DATE;
  v_next_end   DATE;
  v_new_id     TEXT;
  v_existing   INT;
BEGIN
  -- Read the schedule hint (and the group type, added in migration 052)
  SELECT season_start_month, group_type INTO v_ssm, v_gtype
    FROM public.groups WHERE id = p_group_id;
  IF v_ssm IS NULL THEN
    RAISE NOTICE 'ensure_next_season_for_group(%): group not found', p_group_id;
    RETURN NULL;
  END IF;
  -- Rosters are not playing groups; they never get seasons (migration 052).
  IF v_gtype = 'roster' THEN
    RAISE NOTICE 'ensure_next_season_for_group(%): roster group, skipping', p_group_id;
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
$function$;

CREATE OR REPLACE FUNCTION public.ensure_next_season_all_groups()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r           RECORD;
  v_new_id    TEXT;
  v_created   INT := 0;
  v_skipped   INT := 0;
  v_failed    INT := 0;
  v_details   TEXT := '';
  v_err       TEXT;
BEGIN
  -- Rosters are excluded (migration 052) — they are not playing groups.
  FOR r IN SELECT id, name FROM public.groups
            WHERE group_type <> 'roster' ORDER BY name LOOP
    BEGIN
      v_new_id := public.ensure_next_season_for_group(r.id);
      IF v_new_id IS NOT NULL THEN
        v_created := v_created + 1;
        v_details := v_details || format('%s→%s; ', r.name, v_new_id);
      ELSE
        v_skipped := v_skipped + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      v_details := v_details || format('%s FAILED (%s); ', r.name, v_err);
    END;
  END LOOP;

  RAISE NOTICE 'ensure_next_season_all_groups: created=% skipped=% failed=%',
    v_created, v_skipped, v_failed;
  RETURN format('created=%s skipped=%s failed=%s; %s',
    v_created, v_skipped, v_failed, v_details);
END;
$function$;

-- 4. Verify exactly one roster exists (house pattern from migrations 025/032) --
DO $$
DECLARE
  v_rosters INT;
BEGIN
  SELECT count(*) INTO v_rosters FROM public.groups WHERE group_type = 'roster';
  IF v_rosters <> 1 THEN
    RAISE EXCEPTION 'migration 052: expected exactly 1 roster after apply, got %', v_rosters;
  END IF;
END $$;
