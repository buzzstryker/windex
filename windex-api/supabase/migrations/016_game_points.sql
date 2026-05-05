-- Add game_points column to store raw game points (before head-to-head formula).
-- score_value = computed differential (N * game_points - round_total), used for standings.
-- game_points = raw positive game points entered by user or source app.
-- NULL = raw game points not available (pre-2026 imported data).
ALTER TABLE league_scores ADD COLUMN IF NOT EXISTS game_points DOUBLE PRECISION;

COMMENT ON COLUMN league_scores.game_points IS 'Raw game points before head-to-head computation. NULL for legacy rounds where only the differential was imported.';
