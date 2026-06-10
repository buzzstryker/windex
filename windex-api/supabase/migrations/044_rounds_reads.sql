-- Migration 044: rounds_reads — per-player "last viewed the Rounds tab"
-- watermark, for the Rounds unread dot and the PWA icon badge (Tier 1).
--
-- Single global row per player (no group_id): viewing the Rounds tab is one
-- event, and there is no per-group unread UI. Mirrors room_reads (040/041).
-- Not added to the realtime publication — Tier 1 polls on mount/foreground.

CREATE TABLE IF NOT EXISTS rounds_reads (
  player_id    TEXT PRIMARY KEY REFERENCES players(id),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE rounds_reads ENABLE ROW LEVEL SECURITY;

-- Full access to your own watermark row only (exact room_reads pattern).
DROP POLICY IF EXISTS rounds_reads_all ON rounds_reads;
CREATE POLICY rounds_reads_all ON rounds_reads FOR ALL TO authenticated
  USING (player_id IN (SELECT get_my_player_ids()))
  WITH CHECK (player_id IN (SELECT get_my_player_ids()));
