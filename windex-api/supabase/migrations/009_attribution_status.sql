-- Attribution lifecycle: events can be pending attribution review or resolved.
-- Lightweight: attribution_status on league_rounds (no separate queue table).

ALTER TABLE league_rounds
  ADD COLUMN IF NOT EXISTS attribution_status TEXT NOT NULL DEFAULT 'attributed'
    CHECK (attribution_status IN ('attributed', 'pending_attribution', 'attribution_resolved'));

COMMENT ON COLUMN league_rounds.attribution_status IS 'Group/season attribution: attributed (normal), pending_attribution (needs review), attribution_resolved (manually resolved).';

CREATE INDEX IF NOT EXISTS idx_league_rounds_attribution_status ON league_rounds(attribution_status);
