-- windex-api: core schema, RLS, standings view
-- Requires auth.users (Supabase default)

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Sections (optional parent for groups)
CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Groups (Windex leagues)
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  logo_url TEXT,
  section_id TEXT REFERENCES sections(id) ON DELETE SET NULL,
  admin_player_id TEXT,
  season_start_month INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Group members
CREATE TABLE IF NOT EXISTS group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  is_active SMALLINT NOT NULL DEFAULT 1,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, player_id)
);

-- Seasons
CREATE TABLE IF NOT EXISTS seasons (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- League rounds (events)
CREATE TABLE IF NOT EXISTS league_rounds (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  season_id TEXT REFERENCES seasons(id) ON DELETE SET NULL,
  round_id TEXT,
  round_date TEXT NOT NULL,
  submitted_at TIMESTAMPTZ,
  scores_override SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- League scores (per round, per player)
CREATE TABLE IF NOT EXISTS league_scores (
  id TEXT PRIMARY KEY,
  league_round_id TEXT NOT NULL REFERENCES league_rounds(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  score_value DOUBLE PRECISION,
  score_override DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(league_round_id, player_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_groups_user ON groups(user_id);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_seasons_group ON seasons(group_id);
CREATE INDEX IF NOT EXISTS idx_league_rounds_group ON league_rounds(group_id);
CREATE INDEX IF NOT EXISTS idx_league_rounds_season ON league_rounds(season_id);
CREATE INDEX IF NOT EXISTS idx_league_scores_round ON league_scores(league_round_id);

-- Standings view: per season, per player — rounds played and total points (effective score = score_override ?? score_value)
CREATE OR REPLACE VIEW season_standings AS
SELECT
  lr.season_id,
  lr.group_id,
  ls.player_id,
  COUNT(DISTINCT lr.id) AS rounds_played,
  COALESCE(SUM(COALESCE(ls.score_override, ls.score_value)), 0)::DOUBLE PRECISION AS total_points
FROM league_rounds lr
JOIN league_scores ls ON ls.league_round_id = lr.id
WHERE lr.season_id IS NOT NULL
GROUP BY lr.season_id, lr.group_id, ls.player_id;

-- RLS
ALTER TABLE sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE league_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE league_scores ENABLE ROW LEVEL SECURITY;

-- Sections: own data only
CREATE POLICY "sections_select" ON sections FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "sections_insert" ON sections FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "sections_update" ON sections FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "sections_delete" ON sections FOR DELETE USING (auth.uid() = user_id);

-- Groups: own data only
CREATE POLICY "groups_select" ON groups FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "groups_insert" ON groups FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "groups_update" ON groups FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "groups_delete" ON groups FOR DELETE USING (auth.uid() = user_id);

-- Group members: access if user owns the group
CREATE POLICY "group_members_select" ON group_members FOR SELECT
  USING (EXISTS (SELECT 1 FROM groups g WHERE g.id = group_members.group_id AND g.user_id = auth.uid()));
CREATE POLICY "group_members_insert" ON group_members FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM groups g WHERE g.id = group_members.group_id AND g.user_id = auth.uid()));
CREATE POLICY "group_members_update" ON group_members FOR UPDATE
  USING (EXISTS (SELECT 1 FROM groups g WHERE g.id = group_members.group_id AND g.user_id = auth.uid()));
CREATE POLICY "group_members_delete" ON group_members FOR DELETE
  USING (EXISTS (SELECT 1 FROM groups g WHERE g.id = group_members.group_id AND g.user_id = auth.uid()));

-- Seasons: via group ownership
CREATE POLICY "seasons_select" ON seasons FOR SELECT
  USING (EXISTS (SELECT 1 FROM groups g WHERE g.id = seasons.group_id AND g.user_id = auth.uid()));
CREATE POLICY "seasons_insert" ON seasons FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM groups g WHERE g.id = seasons.group_id AND g.user_id = auth.uid()));
CREATE POLICY "seasons_update" ON seasons FOR UPDATE
  USING (EXISTS (SELECT 1 FROM groups g WHERE g.id = seasons.group_id AND g.user_id = auth.uid()));
CREATE POLICY "seasons_delete" ON seasons FOR DELETE
  USING (EXISTS (SELECT 1 FROM groups g WHERE g.id = seasons.group_id AND g.user_id = auth.uid()));

-- League rounds: own data only
CREATE POLICY "league_rounds_select" ON league_rounds FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "league_rounds_insert" ON league_rounds FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "league_rounds_update" ON league_rounds FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "league_rounds_delete" ON league_rounds FOR DELETE USING (auth.uid() = user_id);

-- League scores: via league_round ownership
CREATE POLICY "league_scores_select" ON league_scores FOR SELECT
  USING (EXISTS (SELECT 1 FROM league_rounds lr WHERE lr.id = league_scores.league_round_id AND lr.user_id = auth.uid()));
CREATE POLICY "league_scores_insert" ON league_scores FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM league_rounds lr WHERE lr.id = league_scores.league_round_id AND lr.user_id = auth.uid()));
CREATE POLICY "league_scores_update" ON league_scores FOR UPDATE
  USING (EXISTS (SELECT 1 FROM league_rounds lr WHERE lr.id = league_scores.league_round_id AND lr.user_id = auth.uid()));
CREATE POLICY "league_scores_delete" ON league_scores FOR DELETE
  USING (EXISTS (SELECT 1 FROM league_rounds lr WHERE lr.id = league_scores.league_round_id AND lr.user_id = auth.uid()));
