-- Per-season Cup Champion (manual admin input, separate from auto-computed
-- points-standings winner).
--
-- Backstory: every Windex group can run an end-of-season "Cup" competition
-- (match play playoff, last-tournament shootout, whatever the group decides)
-- whose winner is NOT the same as the player at the top of the points
-- standings. Up to now there's been no way to record that. This adds two
-- nullable columns on seasons (`cup_champion_player_id` + `cup_champion_notes`)
-- so a super admin can pick a player from the group's roster and optionally
-- attach a note explaining how the champion was decided.
--
-- The data is surfaced two places by follow-up UI work (NOT in this migration):
--   1. windex-expo's Previous Seasons section — a "Cup Champion" column on
--      each past-season card. Current-season champion is intentionally hidden
--      on the phone app even when set in admin (decision: end-of-season thing
--      only).
--   2. windex-admin's new "Cup Champions" tab — super-admin-only page listing
--      every group's seasons with a "Set Champion" modal per season row.
--
-- Both columns are NULLable because:
--   - The current season has no champion yet (Cup Champion is end-of-season).
--   - Older seasons may never get one designated (Glide-era data, etc.).
--   - Some groups don't run a Cup-style competition at all.
--
-- ON DELETE SET NULL on the FK so deleting a player record doesn't break the
-- season row. Matches the pattern used by `groups.section_id` and other
-- "reference exists but not load-bearing" FKs in this schema.
--
-- RLS: not touched here. The existing seasons_update policy from migration
-- 015_rls_overhaul.sql gates UPDATE to `am_i_super_admin() OR
-- am_i_group_admin(group_id)`, which already covers super-admin PATCH from
-- the admin client. No new policy needed.
--
-- updated_at: seasons has no auto-bump trigger (verified — only triggers in
-- this DB are link_player_on_auth_signup on auth.users and three
-- log_auth_session_* triggers on auth.sessions). The admin PATCH call in the
-- follow-up UI work will set `updated_at = now()` explicitly. Not adding a
-- generic trigger here — out of scope for one feature.
--
-- Whole migration runs in a single transaction so any FK violation in the
-- backfill step rolls everything back cleanly.

-- =============================================================================
-- 1. Add the two columns
-- =============================================================================
ALTER TABLE public.seasons
  ADD COLUMN IF NOT EXISTS cup_champion_player_id TEXT NULL
    REFERENCES public.players(id) ON DELETE SET NULL;

ALTER TABLE public.seasons
  ADD COLUMN IF NOT EXISTS cup_champion_notes TEXT NULL;

COMMENT ON COLUMN public.seasons.cup_champion_player_id IS
  'Manually-recorded per-season Cup Champion. NULL on current season, on legacy seasons with no designation, and on seasons for groups that do not run a Cup-style competition. Distinct from the auto-computed points standings winner (which is derived from season_standings).';

COMMENT ON COLUMN public.seasons.cup_champion_notes IS
  'Optional free-text note explaining how the Cup Champion was decided (e.g. "18-hole match play playoff", "final tournament shootout"). NULL when no note recorded.';

-- =============================================================================
-- 2. Backfill — six historical Windex Cup champions (2020-2025)
-- =============================================================================
--
-- Source of truth: Buzz's records, provided 2026-05-11. YC Windex has no
-- historical champions (first season still in progress). All other existing
-- seasons stay NULL.
--
-- If any of these player_id values is wrong, the FK constraint added above
-- will reject the UPDATE and the whole migration rolls back.

UPDATE public.seasons
   SET cup_champion_player_id = 'qMStshNBGyuEfGxDTzHD',  -- FJ (Joe Miller)
       updated_at = now()
 WHERE id = 'Cpc.JST0Qx-UpHyj-jNO0Q';  -- 2020

UPDATE public.seasons
   SET cup_champion_player_id = 'rkzvcxQz6y4cbEG9Ja88',  -- Buzz
       updated_at = now()
 WHERE id = 'Mq7kCr1XSWmWxPyCPQNpHg';  -- 2021

UPDATE public.seasons
   SET cup_champion_player_id = 'mGOrrykGEwNu44EBsj0z',  -- Rosie (Scott Roseman)
       updated_at = now()
 WHERE id = 'y9xzLEfVQPmmFa2SJlEwjQ';  -- 2022

UPDATE public.seasons
   SET cup_champion_player_id = 'rkzvcxQz6y4cbEG9Ja88',  -- Buzz
       updated_at = now()
 WHERE id = 'AUE4-xpZRyeLb8zGE6vRcA';  -- 2023

UPDATE public.seasons
   SET cup_champion_player_id = 'a4SKiEpE8tWxPptWvXNU',  -- Dr. Chris (Chris Bradburn)
       updated_at = now()
 WHERE id = 'iFDXNJN8Tc2a4tii7kZxQg';  -- 2024

UPDATE public.seasons
   SET cup_champion_player_id = 'bqlxMT63OrpmLySa7nix',  -- ATrain (Alan Miller)
       updated_at = now()
 WHERE id = 'W8etdIH-RvC7TcJQz8k-hQ';  -- 2025

-- =============================================================================
-- 3. Verify the backfill landed on exactly six rows
-- =============================================================================
--
-- Defensive check: if any season_id above didn't match a real row (e.g. a
-- typo or a season that got deleted), the UPDATE silently no-ops. Without
-- this check the migration would succeed with a partial backfill, which
-- would be a worse outcome than a clean rollback. Aborting here surfaces the
-- problem immediately.
DO $$
DECLARE
  v_count INT;
  v_missing TEXT := '';
  v_id TEXT;
  v_expected_ids TEXT[] := ARRAY[
    'Cpc.JST0Qx-UpHyj-jNO0Q',
    'Mq7kCr1XSWmWxPyCPQNpHg',
    'y9xzLEfVQPmmFa2SJlEwjQ',
    'AUE4-xpZRyeLb8zGE6vRcA',
    'iFDXNJN8Tc2a4tii7kZxQg',
    'W8etdIH-RvC7TcJQz8k-hQ'
  ];
BEGIN
  SELECT COUNT(*) INTO v_count
    FROM public.seasons
   WHERE id = ANY(v_expected_ids)
     AND cup_champion_player_id IS NOT NULL;

  IF v_count <> 6 THEN
    FOREACH v_id IN ARRAY v_expected_ids LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.seasons
         WHERE id = v_id AND cup_champion_player_id IS NOT NULL
      ) THEN
        v_missing := v_missing || format(E'\n  - %s', v_id);
      END IF;
    END LOOP;
    RAISE EXCEPTION
      'cup_champion backfill: expected 6 rows updated, found %. Missing or untouched:%',
      v_count, v_missing;
  END IF;

  RAISE NOTICE 'cup_champion backfill: 6 historical Windex Cup champions seeded';
END $$;
