-- Canonical players read model for UI display and future player-mapping readiness.
-- Minimal: id, display_name, is_active. No FK from group_members/league_scores to keep scope narrow;
-- player_id in those tables remains TEXT; display_name is looked up from players by id.

CREATE TABLE IF NOT EXISTS players (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  is_active SMALLINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, user_id)
);

-- Allow one row per (id, user_id) so the same logical player id can exist per user (canonical per tenant).
CREATE INDEX IF NOT EXISTS idx_players_user ON players(user_id);

ALTER TABLE players ENABLE ROW LEVEL SECURITY;

CREATE POLICY "players_select" ON players FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "players_insert" ON players FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "players_update" ON players FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "players_delete" ON players FOR DELETE USING (auth.uid() = user_id);
