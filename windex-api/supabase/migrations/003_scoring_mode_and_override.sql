-- Domain rules: scoring_mode (points vs win_loss_override), result_type, override metadata.
-- Standings view unchanged: uses COALESCE(score_override, score_value) as effective result.

-- Groups: how scores are interpreted for this group
ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS scoring_mode TEXT NOT NULL DEFAULT 'points';

ALTER TABLE groups
  DROP CONSTRAINT IF EXISTS groups_scoring_mode_check;

ALTER TABLE groups
  ADD CONSTRAINT groups_scoring_mode_check
  CHECK (scoring_mode IN ('points', 'win_loss_override'));

-- League scores: win/loss/tie for win_loss_override mode; override audit
ALTER TABLE league_scores
  ADD COLUMN IF NOT EXISTS result_type TEXT,
  ADD COLUMN IF NOT EXISTS override_actor TEXT,
  ADD COLUMN IF NOT EXISTS override_reason TEXT,
  ADD COLUMN IF NOT EXISTS override_at TIMESTAMPTZ;

ALTER TABLE league_scores
  DROP CONSTRAINT IF EXISTS league_scores_result_type_check;

ALTER TABLE league_scores
  ADD CONSTRAINT league_scores_result_type_check
  CHECK (result_type IS NULL OR result_type IN ('win', 'loss', 'tie'));
