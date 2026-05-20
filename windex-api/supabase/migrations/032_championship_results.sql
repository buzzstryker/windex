-- Per-season full finishing order for each group's championship.
--
-- Backstory: migration 025 added two NULLABLE columns on `seasons`
-- (cup_champion_player_id + cup_champion_notes) to record just the winner.
-- This migration adds the FULL finishing order — every participant gets a
-- `place`, ties allowed (standard competition ranking: 1, 2, 2, 4, 5...).
--
-- Design (locked with Buzz 2026-05-20):
--   * championship_results is the new canonical source for placements.
--   * seasons.cup_champion_player_id stays put, auto-synced via trigger to
--     the place=1 winner. All 6 existing readers (api edge functions, expo
--     Previous Seasons card, admin Cup Champions page) keep working with
--     zero changes. Reader migration is deferred to a future session.
--   * seasons.cup_champion_notes is LEFT ALONE — notes are orthogonal to
--     placements and stay editable on the seasons row.
--   * Tie-for-first edge case: seasons.cup_champion_player_id can only
--     hold one value; the sync trigger picks one arbitrarily via LIMIT 1.
--     Canonical data lives in championship_results. BACKLOG item filed.
--
-- Type note: groups.id, seasons.id, players.id, group_members.player_id are
-- all TEXT (Glide-era string ids). The locked prompt declared group_id and
-- player_id as uuid; that's mechanically impossible since you can't FK a
-- uuid column to a TEXT primary key. Corrected to TEXT here.
--
-- Whole migration runs in a single transaction so any failure rolls back
-- cleanly (incl. the backfill verification at the end).

-- =============================================================================
-- 1. Table
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.championship_results (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id   TEXT NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  group_id    TEXT NOT NULL REFERENCES public.groups(id)  ON DELETE CASCADE,
  player_id   TEXT NOT NULL REFERENCES public.players(id) ON DELETE RESTRICT,
  place       INT  NOT NULL CHECK (place >= 1),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (season_id, player_id)
);

COMMENT ON TABLE public.championship_results IS
  'Full finishing order for each season''s championship. One row per (season_id, player_id). Ties allowed; standard competition ranking convention (e.g. 1, 2, 2, 4). Canonical source for the season winner; seasons.cup_champion_player_id is a synced derivation of place=1.';

CREATE INDEX IF NOT EXISTS idx_championship_results_season_place
  ON public.championship_results (season_id, place);
CREATE INDEX IF NOT EXISTS idx_championship_results_group
  ON public.championship_results (group_id);
CREATE INDEX IF NOT EXISTS idx_championship_results_player
  ON public.championship_results (player_id);

-- =============================================================================
-- 2. Integrity trigger: championship_results.group_id must match seasons.group_id
-- =============================================================================
--
-- CHECK constraints can't cross tables, so enforce via trigger. Without this,
-- a row could be inserted with group_id pointing somewhere other than the
-- season's actual group, which would break the RLS-via-group derivation and
-- corrupt the sync trigger logic.
CREATE OR REPLACE FUNCTION public.championship_results_check_group_match()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_season_group_id TEXT;
BEGIN
  SELECT group_id INTO v_season_group_id
    FROM public.seasons
   WHERE id = NEW.season_id;

  IF v_season_group_id IS NULL THEN
    RAISE EXCEPTION 'championship_results: season_id % does not exist', NEW.season_id;
  END IF;

  IF v_season_group_id <> NEW.group_id THEN
    RAISE EXCEPTION
      'championship_results: group_id % does not match season %''s group_id %',
      NEW.group_id, NEW.season_id, v_season_group_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_championship_results_check_group_match
  ON public.championship_results;
CREATE TRIGGER trg_championship_results_check_group_match
BEFORE INSERT OR UPDATE ON public.championship_results
FOR EACH ROW EXECUTE FUNCTION public.championship_results_check_group_match();

-- =============================================================================
-- 3. Membership enforcement trigger
-- =============================================================================
--
-- Current season: player_id must FK to a group_members row for the group.
-- Historical (prior) seasons: skip the check — players may have since left
-- the group, and we want to backfill freely.
--
-- "Current season" detection: seasons stores start_date / end_date as TEXT
-- in YYYY-MM-DD (lexical = chronological). A season is current iff
-- today is between start and end inclusive. There's no is_current flag.
CREATE OR REPLACE FUNCTION public.championship_results_check_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_is_current BOOLEAN;
  v_today      TEXT := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
  v_member     BOOLEAN;
BEGIN
  SELECT (s.start_date <= v_today AND s.end_date >= v_today)
    INTO v_is_current
    FROM public.seasons s
   WHERE s.id = NEW.season_id;

  -- Only enforce membership for the current season. Past/future seasons are
  -- free-form to support backfill and post-season corrections.
  IF v_is_current IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM public.group_members gm
     WHERE gm.group_id  = NEW.group_id
       AND gm.player_id = NEW.player_id
  ) INTO v_member;

  IF NOT v_member THEN
    RAISE EXCEPTION
      'championship_results: player_id % is not a member of group % (current-season enforcement)',
      NEW.player_id, NEW.group_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_championship_results_check_membership
  ON public.championship_results;
CREATE TRIGGER trg_championship_results_check_membership
BEFORE INSERT OR UPDATE ON public.championship_results
FOR EACH ROW EXECUTE FUNCTION public.championship_results_check_membership();

-- =============================================================================
-- 4. Sync trigger: keep seasons.cup_champion_player_id in lockstep with place=1
-- =============================================================================
--
-- Fires AFTER any change to championship_results. Recomputes the place=1
-- winner for the affected season and writes it back to seasons.
-- LIMIT 1 handles tie-for-first by picking arbitrarily — see file header.
--
-- Note: this trigger updates seasons, which has its own RLS policies. Marking
-- the function SECURITY DEFINER so the update happens with the migration
-- owner's rights (mirrors the pattern in ensure_next_season_for_group from
-- migration 021). Without DEFINER, an admin-only insert into
-- championship_results would fail to sync if the caller lacks seasons UPDATE.
-- am_i_super_admin() is already checked at the outer RLS layer (Phase 5).
CREATE OR REPLACE FUNCTION public.sync_seasons_cup_champion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_season_id TEXT;
  v_winner    TEXT;
BEGIN
  v_season_id := COALESCE(NEW.season_id, OLD.season_id);

  SELECT player_id INTO v_winner
    FROM public.championship_results
   WHERE season_id = v_season_id
     AND place = 1
   ORDER BY created_at ASC  -- deterministic tiebreak: earliest-entered wins
   LIMIT 1;

  UPDATE public.seasons
     SET cup_champion_player_id = v_winner,
         updated_at = now()
   WHERE id = v_season_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_seasons_cup_champion
  ON public.championship_results;
CREATE TRIGGER trg_sync_seasons_cup_champion
AFTER INSERT OR UPDATE OR DELETE ON public.championship_results
FOR EACH ROW EXECUTE FUNCTION public.sync_seasons_cup_champion();

-- =============================================================================
-- 5. Row Level Security
-- =============================================================================
--
-- SELECT: any authenticated user (matches groups/seasons/standings browse-all).
-- INSERT/UPDATE/DELETE: super admin only via am_i_super_admin().
ALTER TABLE public.championship_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY championship_results_select
  ON public.championship_results FOR SELECT TO authenticated USING (true);

CREATE POLICY championship_results_insert
  ON public.championship_results FOR INSERT TO authenticated
  WITH CHECK (am_i_super_admin());

CREATE POLICY championship_results_update
  ON public.championship_results FOR UPDATE TO authenticated
  USING (am_i_super_admin());

CREATE POLICY championship_results_delete
  ON public.championship_results FOR DELETE TO authenticated
  USING (am_i_super_admin());

-- =============================================================================
-- 6. Backfill from existing seasons.cup_champion_player_id
-- =============================================================================
--
-- Every non-null cup_champion_player_id becomes a place=1 row in the new
-- table. The sync trigger fires per row, harmlessly re-writing the same
-- value back onto seasons.cup_champion_player_id (no-op).
--
-- The membership trigger does NOT block backfill: every historical season
-- is past, so the "skip if not current" branch returns early.
INSERT INTO public.championship_results (season_id, group_id, player_id, place)
SELECT id, group_id, cup_champion_player_id, 1
  FROM public.seasons
 WHERE cup_champion_player_id IS NOT NULL;

-- =============================================================================
-- 7. Verify backfill row count matches source
-- =============================================================================
--
-- Defensive check: if the row counts diverge (e.g. a season had a champion
-- pointing at a non-existent player, blocked by FK), abort the whole
-- migration so partial state never lands. Mirrors migration 025's pattern.
DO $$
DECLARE
  v_expected INT;
  v_actual   INT;
BEGIN
  SELECT COUNT(*) INTO v_expected
    FROM public.seasons
   WHERE cup_champion_player_id IS NOT NULL;

  SELECT COUNT(*) INTO v_actual
    FROM public.championship_results
   WHERE place = 1;

  IF v_actual <> v_expected THEN
    RAISE EXCEPTION
      'championship_results backfill: expected % rows (from seasons.cup_champion_player_id IS NOT NULL), found %',
      v_expected, v_actual;
  END IF;

  RAISE NOTICE 'championship_results backfill: % historical winners seeded as place=1', v_actual;
END $$;
