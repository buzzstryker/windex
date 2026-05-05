-- Natural key for idempotent ingestion: (group_id, source_app, external_event_id)

ALTER TABLE league_rounds
  ADD COLUMN IF NOT EXISTS source_app TEXT,
  ADD COLUMN IF NOT EXISTS external_event_id TEXT;

-- Uniqueness when both source_app and external_event_id are set (one event per external id per group)
CREATE UNIQUE INDEX IF NOT EXISTS idx_league_rounds_external_event
  ON league_rounds (group_id, source_app, external_event_id)
  WHERE source_app IS NOT NULL AND external_event_id IS NOT NULL;
