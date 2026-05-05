-- Payout config on groups: enables compute-money-deltas to write league_scores.money_delta.
-- Standings remain points-only; money_delta is for settlement/Venmo only.
-- NULL = not configured (computed: false, no write). 0 or positive = rate in $ per point (zero-sum from round mean).

ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS dollars_per_point DOUBLE PRECISION NULL;

ALTER TABLE groups
  DROP CONSTRAINT IF EXISTS groups_dollars_per_point_check;

ALTER TABLE groups
  ADD CONSTRAINT groups_dollars_per_point_check
  CHECK (dollars_per_point IS NULL OR dollars_per_point >= 0);
