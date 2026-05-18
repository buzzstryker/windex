-- Migration 030: filter retired players out of standings where they didn't score.
--
-- Player retirement Phase 1 (migration 029) keeps retired players visible in
-- season_standings so their historical scored rounds survive. Side effect:
-- because the view anchors on group_members × seasons, a retired player shows
-- up in EVERY season of their group(s) — including the many seasons where
-- they have rounds_played = 0 (e.g. Frenchie: 16 Windex Cup rows, only 1 with
-- an actual round).
--
-- Buzz's rule:
--   * Active players  (players.retired_at IS NULL)     — appear in ALL
--     standings regardless of rounds_played (unchanged behaviour).
--   * Retired players (players.retired_at IS NOT NULL)  — appear ONLY in
--     seasons where rounds_played > 0.
--
-- Implementation: HAVING clause. The view already aggregates with
-- GROUP BY (s.id, gm.group_id, gm.player_id). We add a LEFT JOIN to players
-- (LEFT, so an orphan group_members.player_id with no players row is treated
-- as not-retired and is NOT dropped — preserves current behaviour for active
-- players exactly) and append p.retired_at to GROUP BY. p.retired_at is
-- functionally constant per player_id (join is on the players PK p.id), so
-- adding it to GROUP BY produces identical groups — rounds_played,
-- total_points, wins, losses and ties are provably unchanged. The HAVING
-- then drops only retired players' zero-round rows.
--
-- Everything else about the view is preserved verbatim: the 8 output columns
-- (names, order, types), every aggregation expression, the group_members ⨝
-- seasons join, the (league_scores ⨝ league_rounds) LEFT JOIN subtree, and
-- the WHERE gm.is_active = 1 filter. The view has no ORDER BY (callers, e.g.
-- the get-standings Edge Function, order by total_points themselves), so
-- there is nothing to preserve there.

CREATE OR REPLACE VIEW season_standings AS
SELECT
  s.id                                    AS season_id,
  gm.group_id,
  gm.player_id,
  COUNT(DISTINCT lr.id)                   AS rounds_played,
  COALESCE(
    SUM(COALESCE(ls.score_override, ls.score_value)),
    0
  )::DOUBLE PRECISION                     AS total_points,
  COUNT(*) FILTER (
    WHERE COALESCE(ls.score_override, ls.score_value) > 0
  )                                       AS wins,
  COUNT(*) FILTER (
    WHERE COALESCE(ls.score_override, ls.score_value) < 0
  )                                       AS losses,
  COUNT(*) FILTER (
    WHERE COALESCE(ls.score_override, ls.score_value) = 0
  )                                       AS ties
FROM group_members gm
JOIN seasons s
  ON s.group_id = gm.group_id
LEFT JOIN players p
  ON p.id = gm.player_id
LEFT JOIN (
  league_scores ls
  JOIN league_rounds lr ON lr.id = ls.league_round_id
) ON  ls.player_id = gm.player_id
  AND lr.season_id  = s.id
  AND lr.group_id   = gm.group_id
WHERE gm.is_active = 1
GROUP BY s.id, gm.group_id, gm.player_id, p.retired_at
HAVING p.retired_at IS NULL OR COUNT(DISTINCT lr.id) > 0;
