-- Add wins / losses / ties counts to season_standings, computed from the
-- effective per-round score (override-priority, matching total_points).
--
-- Note: CREATE OR REPLACE VIEW cannot reorder or rename existing columns;
-- new columns must be appended at the end of the SELECT list.

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
LEFT JOIN (
  league_scores ls
  JOIN league_rounds lr ON lr.id = ls.league_round_id
) ON  ls.player_id = gm.player_id
  AND lr.season_id  = s.id
  AND lr.group_id   = gm.group_id
WHERE gm.is_active = 1
GROUP BY s.id, gm.group_id, gm.player_id;
