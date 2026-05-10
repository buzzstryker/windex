-- Season auto-rollover.
--
-- Backstory: Windex had no automation for creating new seasons. YC Windex's
-- 2026 season ends 2026-08-31; without rollover, members would be locked out
-- of round creation on 2026-09-01 per the "current season only" rule in
-- Windex_Permissions_Spec.md. Diagnostic 2026-05-09 (scripts/check-season-
-- start-months.mjs) confirmed zero existing automation and surfaced one
-- season_start_month data bug (see step 1 below).
--
-- This migration:
--   1. One-time data fix for Windex Cup's season_start_month (Glide imported
--      the wrong value).
--   2. Defensive verification: halt the migration if any group still has a
--      ssm vs recent-start-month mismatch after step 1.
--   3. CREATE EXTENSION pg_cron (Supabase-supported across all plans).
--   4. ensure_next_season_for_group(group_id) — SECURITY DEFINER, idempotent.
--      Reads the most recent season's end_date and creates the row that
--      starts the day after, runs for one calendar year minus a day.
--      season_start_month is only used as a "skip if 0/null" gate; the
--      actual date math comes from end_date so the schedule self-perpetuates.
--   5. ensure_next_season_all_groups() — wrapper that loops every group.
--   6. cron.schedule registers a daily 6 AM UTC job calling the wrapper.
--   7. Initial run during this migration seeds the next season for every
--      currently-existing group (YC Windex 2027, Windex Cup 2027).
--
-- Whole migration runs in a single transaction, so if any step fails (notably
-- the verification in step 2 or CREATE EXTENSION in step 3) everything rolls
-- back cleanly.

-- =============================================================================
-- 1. One-time data fix for Windex Cup
-- =============================================================================
--
-- One-time data fix: Windex Cup's season_start_month was imported as 2 (Feb)
-- from Glide but its actual schedule is Dec-Nov. The Create Season UI in this
-- same migration uses season_start_month to default new seasons' start dates,
-- so correct it before that code goes live. YC Windex (the only other active
-- group) was verified correct at 9 (Sept).
UPDATE groups
   SET season_start_month = 12,
       updated_at = now()
 WHERE id = '4kKh0sk1QpSvjPE6p8VNKA' -- Windex Cup
   AND season_start_month <> 12;     -- guard against re-run drift

-- Idempotent confirmation that YC Windex's value is what the diagnostic saw.
-- No-op if already 9; surfaces a NOTICE if the value drifted.
DO $$
DECLARE
  v_ssm INT;
BEGIN
  SELECT season_start_month INTO v_ssm FROM groups WHERE id = 'a-f-NDMUNTtGA6JxDT8S9CQ';
  IF v_ssm IS NULL THEN
    RAISE NOTICE 'YC Windex (a-f-NDMUNTtGA6JxDT8S9CQ) not found — skipping confirmation';
  ELSIF v_ssm <> 9 THEN
    RAISE NOTICE 'YC Windex season_start_month is % (expected 9 per diagnostic 2026-05-09) — flagging for review', v_ssm;
  END IF;
END $$;

-- =============================================================================
-- 2. Defensive verification: halt on remaining mismatches
-- =============================================================================
--
-- After the data fix above, every group with seasons should have
-- season_start_month matching its most-recent-season's start month (or be
-- ssm=0 for "no schedule defined"). If anything still mismatches at this
-- point, abort the whole migration so we don't lock in cron over bad data.
DO $$
DECLARE
  r RECORD;
  v_recent_month INT;
  v_mismatches INT := 0;
  v_summary TEXT := '';
BEGIN
  FOR r IN SELECT id, name, season_start_month FROM groups ORDER BY name LOOP
    SELECT EXTRACT(MONTH FROM start_date::date)::int
      INTO v_recent_month
      FROM seasons
     WHERE group_id = r.id
     ORDER BY end_date DESC
     LIMIT 1;

    IF v_recent_month IS NULL THEN
      CONTINUE; -- no seasons yet; bootstrap via Create Season UI
    END IF;
    IF r.season_start_month = 0 THEN
      CONTINUE; -- explicitly opted out of auto-rollover
    END IF;

    IF v_recent_month <> r.season_start_month THEN
      v_mismatches := v_mismatches + 1;
      v_summary := v_summary || format(
        E'\n  - %s (%s): season_start_month=%s but recent season starts in month %s',
        r.name, r.id, r.season_start_month, v_recent_month
      );
    END IF;
  END LOOP;

  IF v_mismatches > 0 THEN
    RAISE EXCEPTION
      'season_rollover migration: % groups still have season_start_month / recent-start mismatch:%',
      v_mismatches, v_summary;
  END IF;

  RAISE NOTICE 'season_rollover verification: all groups consistent';
END $$;

-- =============================================================================
-- 3. Enable pg_cron
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- =============================================================================
-- 4. ensure_next_season_for_group(p_group_id)
-- =============================================================================
--
-- Per-group idempotent rollover. Returns the new season's id, or NULL if
-- nothing was created (already exists / no seed season / schedule disabled).
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
  'Idempotently ensure the next season exists for a group. Returns new season id or NULL.';

-- =============================================================================
-- 5. ensure_next_season_all_groups()
-- =============================================================================
--
-- Wrapper: loop every group, call the per-group function. Returns a
-- human-readable summary string for cron logs. Any per-group exception is
-- caught + logged so a single bad row doesn't fail the whole sweep.
CREATE OR REPLACE FUNCTION public.ensure_next_season_all_groups()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r           RECORD;
  v_new_id    TEXT;
  v_created   INT := 0;
  v_skipped   INT := 0;
  v_failed    INT := 0;
  v_details   TEXT := '';
  v_err       TEXT;
BEGIN
  FOR r IN SELECT id, name FROM public.groups ORDER BY name LOOP
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
$$;

COMMENT ON FUNCTION public.ensure_next_season_all_groups() IS
  'Daily rollover entry point. Calls ensure_next_season_for_group for every group; per-group failures are caught + logged.';

-- =============================================================================
-- 6. Schedule the daily cron job
-- =============================================================================
--
-- 6:00 AM UTC = 10–11 PM Pacific (depending on DST), well outside any
-- user-facing hours. cron.schedule() upserts by jobname, so re-running this
-- migration is safe.
SELECT cron.schedule(
  'windex-season-rollover-daily',
  '0 6 * * *',
  'SELECT public.ensure_next_season_all_groups();'
);

-- =============================================================================
-- 7. Initial run — seed the next season for every existing group
-- =============================================================================
--
-- For 2026-05-09 deploy: this should create
--   YC Windex   2026-09-01 → 2027-08-31
--   Windex Cup  2026-12-01 → 2027-11-30
-- Both are 4-7 months early but harmless — sit dormant until their
-- start_date arrives. The expo picker filters out future-dated seasons via
-- the lib/api.ts listSeasons change in this same PR, so they don't appear in
-- the user-facing season selector until they're actually current.
SELECT public.ensure_next_season_all_groups();
