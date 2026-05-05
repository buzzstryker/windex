-- Points ledger + standings aggregation: formalize architecture in schema comments.
-- league_scores = canonical atomic point records (one per player per round).
-- season_standings = read-only view derived from league_scores; standings are never edited directly.

COMMENT ON TABLE league_scores IS
  'Points ledger: one atomic point record per (league_round_id, player_id). Effective points = COALESCE(score_override, score_value). Standings are derived from this table via season_standings view; do not maintain a separate mutable standings table.';

COMMENT ON VIEW season_standings IS
  'Standings aggregation: derived from league_rounds JOIN league_scores only. Read-only; total_points and rounds_played are computed on read. Do not edit standings directly; change atomic point records in league_scores (e.g. via round edit/override).';
