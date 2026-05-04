-- Include all active group members in season_standings, even those with zero rounds.
-- Previously the view started from league_rounds JOIN league_scores, so members who
-- hadn't played any rounds were invisible. Now we anchor on group_members × seasons
-- and LEFT JOIN into the scores ledger.

CREATE OR REPLACE VIEW season_standings AS
SELECT
  s.id                                    AS season_id,
  gm.group_id,
  gm.player_id,
  COUNT(DISTINCT lr.id)                   AS rounds_played,
  COALESCE(
    SUM(COALESCE(ls.score_override, ls.score_value)),
    0
  )::DOUBLE PRECISION                     AS total_points
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
