-- Event-level processing visibility: ingest outcome status and unresolved count.
-- Lightweight: processing_status (processed | partial_unresolved_players | validation_error), unresolved_player_count.

ALTER TABLE league_rounds
  ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'processed'
    CHECK (processing_status IN ('processed', 'partial_unresolved_players', 'validation_error')),
  ADD COLUMN IF NOT EXISTS unresolved_player_count SMALLINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN league_rounds.processing_status IS 'Ingest outcome: processed (all resolved), partial_unresolved_players (some skipped), validation_error (reserved).';
COMMENT ON COLUMN league_rounds.unresolved_player_count IS 'Number of submitted scores skipped due to unresolved player mapping (when processing_status = partial_unresolved_players).';

CREATE INDEX IF NOT EXISTS idx_league_rounds_processing_status ON league_rounds(processing_status);
