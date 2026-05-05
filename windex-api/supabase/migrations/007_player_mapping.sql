-- Player mapping: queue for unresolved source-player identities and resolved mapping store.
-- Admin-focused; minimal. Future ingestion can look up canonical player_id from player_mappings.

-- Queue: unresolved (and optionally resolved for audit) source-player identities.
CREATE TABLE IF NOT EXISTS player_mapping_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_app TEXT,
  source_player_name TEXT NOT NULL,
  source_player_ref TEXT,
  related_league_round_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  canonical_player_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_player_mapping_queue_user ON player_mapping_queue(user_id);
CREATE INDEX IF NOT EXISTS idx_player_mapping_queue_status ON player_mapping_queue(status);

ALTER TABLE player_mapping_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "player_mapping_queue_select" ON player_mapping_queue FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "player_mapping_queue_insert" ON player_mapping_queue FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "player_mapping_queue_update" ON player_mapping_queue FOR UPDATE USING (auth.uid() = user_id);

-- Resolved mapping store: source identity -> canonical player. Used by future ingestion to set player_id.
-- Lookup key: (user_id, source_app, source_player_ref). source_player_ref = source_player_ref from queue or source_player_name.
CREATE TABLE IF NOT EXISTS player_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_app TEXT NOT NULL,
  source_player_ref TEXT NOT NULL,
  canonical_player_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, source_app, source_player_ref)
);

CREATE INDEX IF NOT EXISTS idx_player_mappings_user ON player_mappings(user_id);

ALTER TABLE player_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "player_mappings_select" ON player_mappings FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "player_mappings_insert" ON player_mappings FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "player_mappings_update" ON player_mappings FOR UPDATE USING (auth.uid() = user_id);

COMMENT ON TABLE player_mapping_queue IS 'Unresolved source-player identities for admin review. status=pending for queue; resolved items keep canonical_player_id for audit.';
COMMENT ON TABLE player_mappings IS 'Resolved source -> canonical player. Future ingestion uses (user_id, source_app, source_player_ref) to set player_id.';
