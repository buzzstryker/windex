-- Settlement readiness: per-result money delta for settlement requests / Venmo insert generation.
-- Standings remain based only on effective points; this column is not used in season_standings.

ALTER TABLE league_scores
  ADD COLUMN IF NOT EXISTS money_delta DOUBLE PRECISION NULL;
