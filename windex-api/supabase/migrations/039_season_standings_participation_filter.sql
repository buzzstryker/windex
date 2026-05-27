-- Migration 039: season_standings — drop ghost members from COMPLETED seasons,
-- while preserving the roster-at-zero preview for current/future seasons.
--
-- PROBLEM
-- The view's HAVING clause (migration 030) was:
--   (p.retired_at IS NULL) OR (count(DISTINCT lr.id) > 0)
-- The OR is too permissive: any active member passes regardless of whether
-- they played that season. So a player who became a member in 2026 appears
-- in 2019..2024 standings with 0 rounds / 0 points (the LEFT JOIN to
-- league_scores returns no matches, but the HAVING still admits the row).
-- Concretely, Pat Callahan and Dave Kaufman ("Bübes") joined on 2026-03-26
-- and showed up in every historical season as last-place zeros.
--
-- WHY NOT A JOIN-DATE FILTER
-- The intuitive fix is "exclude members from seasons that ended before they
-- joined." It is not implementable here: group_members.joined_at for the
-- affected group (4kKh0sk1QpSvjPE6p8VNKA) is a single backfill instant —
-- all 14 members share joined_at = 2026-03-26 19:19:04.346402+00
-- (count(distinct joined_at) = 1). players.created_at is the same backfill
-- instant (2026-03-26 19:19:04.209855+00). A 2019 founding member and a 2026
-- newcomer are indistinguishable. (The a-f group has real per-member
-- joined_at values, but it has no pre-2025 history, so nothing to fix there.)
-- Filtering on joined_at <= season end would therefore drop EVERY member from
-- EVERY pre-2026 season — worse than doing nothing.
--
-- THE PREDICATE WE CAN TRUST: "has the season ended?"
-- A season is completed when its end_date has passed. That lets us require
-- participation only for finished seasons, and keep the full active roster
-- for seasons still in progress or yet to start:
--
--   HAVING count(DISTINCT lr.id) > 0
--       OR (p.retired_at IS NULL AND s.end_date::date >= current_date)
--
-- Reads as: a player appears in a season's standings iff they played at least
-- one round in it, OR they are an active (non-retired) member and the season
-- has not ended yet.
--
-- This unifies the three prior intents:
--   * Migration 018 (roster-at-zero): preserved for current/future seasons —
--     a freshly rolled-over season still shows the full roster at 0 points
--     until its first round, so standings pages are never empty at rollover.
--   * Migration 030 (no retired padding): preserved — a retired player with
--     0 rounds is admitted only where they actually scored (the retired_at
--     guard sits inside the not-ended branch only).
--   * The new fix: completed seasons require participation, so 2026 joiners
--     (and anyone who skipped a finished season) no longer appear as zeros.
--
-- ROWS DROPPED (measured against production 2026-05-26, current_date):
-- season_standings goes from 415 rows to 398 — 17 rows removed, all active
-- members with 0 rounds in COMPLETED seasons:
--   Pat Callahan   — 2019,2020,2021,2022,2023,2024  (6)  [the reported bug]
--   Dave Kaufman   — 2019,2020,2021,2022,2023,2024  (6)  [the reported bug]
--   Colm Moran     — 2019,2020,2021                 (3)  [joined later]
--   Cal Lyford     — 2019                           (1)  [absent that season]
--   Steve Dietz    — 2019                           (1)  [absent that season]
-- None of these have any league_scores rows in the dropped seasons — pure
-- view-logic, no data cleanup. The 343 current/future roster rows are kept.
--
-- TIME-DEPENDENCY (intended, but note it):
-- Because the predicate references current_date, the view's row count drifts
-- over time. When a season's end_date passes, its non-participants drop
-- automatically. Every Dec 1 rollover, the prior season's zero-round members
-- fall out of that season's standings once it closes. This is the desired
-- dynamic, not a bug.
--
-- Everything else is preserved verbatim from migration 030: the 8 output
-- columns (names, order, types), every aggregation expression, the join tree,
-- the WHERE gm.is_active = 1 filter, and the GROUP BY. s.end_date is
-- referenceable in HAVING because s.id (seasons PK) is in the GROUP BY, so
-- all of seasons' columns are functionally dependent.

CREATE OR REPLACE VIEW public.season_standings AS
SELECT
  s.id                                    AS season_id,
  gm.group_id,
  gm.player_id,
  count(DISTINCT lr.id)                   AS rounds_played,
  COALESCE(
    sum(COALESCE(ls.score_override, ls.score_value)),
    0
  )::double precision                     AS total_points,
  count(*) FILTER (
    WHERE COALESCE(ls.score_override, ls.score_value) > 0::double precision
  )                                       AS wins,
  count(*) FILTER (
    WHERE COALESCE(ls.score_override, ls.score_value) < 0::double precision
  )                                       AS losses,
  count(*) FILTER (
    WHERE COALESCE(ls.score_override, ls.score_value) = 0::double precision
  )                                       AS ties
FROM group_members gm
  JOIN seasons s ON s.group_id = gm.group_id
  LEFT JOIN players p ON p.id = gm.player_id
  LEFT JOIN (league_scores ls
    JOIN league_rounds lr ON lr.id = ls.league_round_id)
    ON ls.player_id = gm.player_id
       AND lr.season_id = s.id
       AND lr.group_id = gm.group_id
WHERE gm.is_active = 1
GROUP BY s.id, gm.group_id, gm.player_id, p.retired_at
HAVING count(DISTINCT lr.id) > 0
    OR (p.retired_at IS NULL AND s.end_date::date >= current_date);

-- Verification. Keyed on player IDs (not display_name — Dave's display_name
-- is "Bübes", so a display_name = 'Dave' test would silently match nothing).
-- The invariant is GHOST rows (rounds_played = 0) in COMPLETED seasons, not
-- all completed-season rows: a player who actually played a finished season
-- (e.g. Colm in 2022/2023/2024) legitimately keeps those rows.
DO $$
DECLARE
  v_pat   INT;  -- Pat Callahan  xHaogjo0SibeROMZBr5g — 0 rounds in every completed season
  v_dave  INT;  -- Dave Kaufman  TnwDQXFsv0Pz0DMyG4GH ("Bübes") — same
  v_colm  INT;  -- Colm Moran    YytMRmEEFc5bFdo6vPMA — ghost only in 2019-2021
  v_ghosts_all INT;  -- global: any zero-round row left in a completed season
  v_cur_4kkh   INT;  -- 4kKh 2025-12 season EL3Iy8WMR7COX0FSuaLV1Q
  v_cur_af     INT;  -- a-f  2025-09 season NhQ38YGqQNhvBjWqzCqb
  v_future     INT;  -- 4kKh 2026-12 season sn_4kKh0sk1QpSvjPE6p8VNKA_2027
  v_total      INT;
BEGIN
  -- 1-3: zero GHOST (rounds_played = 0) rows in COMPLETED seasons per player
  SELECT count(*) INTO v_pat FROM public.season_standings ss
    JOIN public.seasons s ON s.id = ss.season_id
    WHERE ss.player_id = 'xHaogjo0SibeROMZBr5g' AND s.end_date::date < current_date AND ss.rounds_played = 0;
  SELECT count(*) INTO v_dave FROM public.season_standings ss
    JOIN public.seasons s ON s.id = ss.season_id
    WHERE ss.player_id = 'TnwDQXFsv0Pz0DMyG4GH' AND s.end_date::date < current_date AND ss.rounds_played = 0;
  SELECT count(*) INTO v_colm FROM public.season_standings ss
    JOIN public.seasons s ON s.id = ss.season_id
    WHERE ss.player_id = 'YytMRmEEFc5bFdo6vPMA' AND s.end_date::date < current_date AND ss.rounds_played = 0;

  -- global spot-check: NO zero-round rows survive in any completed season
  SELECT count(*) INTO v_ghosts_all FROM public.season_standings ss
    JOIN public.seasons s ON s.id = ss.season_id
    WHERE s.end_date::date < current_date AND ss.rounds_played = 0;

  -- rosters intact for current + future seasons
  SELECT count(*) INTO v_cur_4kkh FROM public.season_standings WHERE season_id = 'EL3Iy8WMR7COX0FSuaLV1Q';
  SELECT count(*) INTO v_cur_af   FROM public.season_standings WHERE season_id = 'NhQ38YGqQNhvBjWqzCqb';
  SELECT count(*) INTO v_future   FROM public.season_standings WHERE season_id = 'sn_4kKh0sk1QpSvjPE6p8VNKA_2027';

  SELECT count(*) INTO v_total FROM public.season_standings;

  RAISE NOTICE 'Pat ghost rows in completed seasons:  % (expected 0)', v_pat;
  RAISE NOTICE 'Dave ghost rows in completed seasons: % (expected 0)', v_dave;
  RAISE NOTICE 'Colm ghost rows in completed seasons: % (expected 0; he keeps 2022/2023/2024)', v_colm;
  RAISE NOTICE 'Global zero-round rows in completed seasons: % (expected 0)', v_ghosts_all;
  RAISE NOTICE '4kKh 2025-12 roster:  % (expected 12)', v_cur_4kkh;
  RAISE NOTICE 'a-f  2025-09 roster:  % (expected 6)',  v_cur_af;
  RAISE NOTICE '4kKh 2026-12 future roster: % (expected 12)', v_future;
  RAISE NOTICE 'Total season_standings rows: % (expected ~398, was 415; drifts with current_date)', v_total;

  IF v_pat <> 0 OR v_dave <> 0 OR v_colm <> 0 OR v_ghosts_all <> 0 THEN
    RAISE EXCEPTION 'Ghost rows remain in completed seasons: Pat=% Dave=% Colm=% global=%', v_pat, v_dave, v_colm, v_ghosts_all;
  END IF;
  IF v_cur_4kkh <> 12 OR v_cur_af <> 6 OR v_future <> 12 THEN
    RAISE EXCEPTION 'Roster regression: 4kKh-current=% a-f-current=% 4kKh-future=%', v_cur_4kkh, v_cur_af, v_future;
  END IF;
END $$;
