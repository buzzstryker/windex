-- RLS policy overhaul: replace single-owner policies with role-based policies.
-- Uses helper functions from migration 014: am_i_super_admin(), am_i_group_admin(), am_i_group_member().

-- ============================================================
-- SECTIONS
-- ============================================================
DROP POLICY IF EXISTS sections_select ON sections;
DROP POLICY IF EXISTS sections_insert ON sections;
DROP POLICY IF EXISTS sections_update ON sections;
DROP POLICY IF EXISTS sections_delete ON sections;

CREATE POLICY sections_select ON sections FOR SELECT TO authenticated USING (true);
CREATE POLICY sections_insert ON sections FOR INSERT TO authenticated WITH CHECK (am_i_super_admin());
CREATE POLICY sections_update ON sections FOR UPDATE TO authenticated USING (am_i_super_admin());
CREATE POLICY sections_delete ON sections FOR DELETE TO authenticated USING (am_i_super_admin());

-- ============================================================
-- GROUPS
-- ============================================================
DROP POLICY IF EXISTS groups_select ON groups;
DROP POLICY IF EXISTS groups_insert ON groups;
DROP POLICY IF EXISTS groups_update ON groups;
DROP POLICY IF EXISTS groups_delete ON groups;
DROP POLICY IF EXISTS "select_own_groups" ON groups;
DROP POLICY IF EXISTS "insert_own_groups" ON groups;
DROP POLICY IF EXISTS "update_own_groups" ON groups;
DROP POLICY IF EXISTS "delete_own_groups" ON groups;

CREATE POLICY groups_select ON groups FOR SELECT TO authenticated USING (true);
CREATE POLICY groups_insert ON groups FOR INSERT TO authenticated WITH CHECK (am_i_super_admin());
CREATE POLICY groups_update ON groups FOR UPDATE TO authenticated
  USING (am_i_super_admin() OR am_i_group_admin(id));
CREATE POLICY groups_delete ON groups FOR DELETE TO authenticated USING (am_i_super_admin());

-- ============================================================
-- GROUP_MEMBERS
-- ============================================================
DROP POLICY IF EXISTS group_members_select ON group_members;
DROP POLICY IF EXISTS group_members_insert ON group_members;
DROP POLICY IF EXISTS group_members_update ON group_members;
DROP POLICY IF EXISTS group_members_delete ON group_members;
DROP POLICY IF EXISTS "select_group_members" ON group_members;
DROP POLICY IF EXISTS "insert_group_members" ON group_members;
DROP POLICY IF EXISTS "update_group_members" ON group_members;
DROP POLICY IF EXISTS "delete_group_members" ON group_members;

CREATE POLICY group_members_select ON group_members FOR SELECT TO authenticated USING (true);
CREATE POLICY group_members_insert ON group_members FOR INSERT TO authenticated
  WITH CHECK (am_i_super_admin() OR am_i_group_admin(group_id));
CREATE POLICY group_members_update ON group_members FOR UPDATE TO authenticated
  USING (am_i_super_admin() OR am_i_group_admin(group_id));
CREATE POLICY group_members_delete ON group_members FOR DELETE TO authenticated
  USING (am_i_super_admin() OR am_i_group_admin(group_id));

-- ============================================================
-- PLAYERS
-- ============================================================
DROP POLICY IF EXISTS players_select ON players;
DROP POLICY IF EXISTS players_insert ON players;
DROP POLICY IF EXISTS players_update ON players;
DROP POLICY IF EXISTS players_delete ON players;

CREATE POLICY players_select ON players FOR SELECT TO authenticated USING (true);
CREATE POLICY players_insert ON players FOR INSERT TO authenticated
  WITH CHECK (am_i_super_admin() OR user_id = auth.uid());
CREATE POLICY players_update ON players FOR UPDATE TO authenticated
  USING (am_i_super_admin() OR user_id = auth.uid());
CREATE POLICY players_delete ON players FOR DELETE TO authenticated USING (am_i_super_admin());

-- ============================================================
-- SEASONS
-- ============================================================
DROP POLICY IF EXISTS seasons_select ON seasons;
DROP POLICY IF EXISTS seasons_insert ON seasons;
DROP POLICY IF EXISTS seasons_update ON seasons;
DROP POLICY IF EXISTS seasons_delete ON seasons;

CREATE POLICY seasons_select ON seasons FOR SELECT TO authenticated USING (true);
CREATE POLICY seasons_insert ON seasons FOR INSERT TO authenticated
  WITH CHECK (am_i_super_admin() OR am_i_group_admin(group_id));
CREATE POLICY seasons_update ON seasons FOR UPDATE TO authenticated
  USING (am_i_super_admin() OR am_i_group_admin(group_id));
CREATE POLICY seasons_delete ON seasons FOR DELETE TO authenticated
  USING (am_i_super_admin());

-- ============================================================
-- LEAGUE_ROUNDS
-- ============================================================
DROP POLICY IF EXISTS league_rounds_select ON league_rounds;
DROP POLICY IF EXISTS league_rounds_insert ON league_rounds;
DROP POLICY IF EXISTS league_rounds_update ON league_rounds;
DROP POLICY IF EXISTS league_rounds_delete ON league_rounds;

-- Any authenticated user can read all rounds
CREATE POLICY league_rounds_select ON league_rounds FOR SELECT TO authenticated USING (true);

-- Any member of the group can create rounds
CREATE POLICY league_rounds_insert ON league_rounds FOR INSERT TO authenticated
  WITH CHECK (am_i_group_member(group_id));

-- Super admin or group admin can update/delete
CREATE POLICY league_rounds_update ON league_rounds FOR UPDATE TO authenticated
  USING (am_i_super_admin() OR am_i_group_admin(group_id));
CREATE POLICY league_rounds_delete ON league_rounds FOR DELETE TO authenticated
  USING (am_i_super_admin() OR am_i_group_admin(group_id));

-- ============================================================
-- LEAGUE_SCORES
-- ============================================================
DROP POLICY IF EXISTS league_scores_select ON league_scores;
DROP POLICY IF EXISTS league_scores_insert ON league_scores;
DROP POLICY IF EXISTS league_scores_update ON league_scores;
DROP POLICY IF EXISTS league_scores_delete ON league_scores;

-- Any authenticated user can read all scores
CREATE POLICY league_scores_select ON league_scores FOR SELECT TO authenticated USING (true);

-- Insert: must be member of the round's group
CREATE POLICY league_scores_insert ON league_scores FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM league_rounds lr
      WHERE lr.id = league_scores.league_round_id
        AND am_i_group_member(lr.group_id)
    )
  );

-- Update/delete: super admin or group admin of the round's group
CREATE POLICY league_scores_update ON league_scores FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM league_rounds lr
      WHERE lr.id = league_scores.league_round_id
        AND (am_i_super_admin() OR am_i_group_admin(lr.group_id))
    )
  );
CREATE POLICY league_scores_delete ON league_scores FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM league_rounds lr
      WHERE lr.id = league_scores.league_round_id
        AND (am_i_super_admin() OR am_i_group_admin(lr.group_id))
    )
  );

-- ============================================================
-- PLAYER_MAPPINGS
-- ============================================================
DROP POLICY IF EXISTS player_mappings_select ON player_mappings;
DROP POLICY IF EXISTS player_mappings_insert ON player_mappings;
DROP POLICY IF EXISTS player_mappings_update ON player_mappings;

CREATE POLICY player_mappings_select ON player_mappings FOR SELECT TO authenticated USING (true);
CREATE POLICY player_mappings_insert ON player_mappings FOR INSERT TO authenticated
  WITH CHECK (am_i_super_admin() OR user_id = auth.uid());
CREATE POLICY player_mappings_update ON player_mappings FOR UPDATE TO authenticated
  USING (am_i_super_admin() OR user_id = auth.uid());

-- ============================================================
-- PLAYER_MAPPING_QUEUE
-- ============================================================
DROP POLICY IF EXISTS player_mapping_queue_select ON player_mapping_queue;
DROP POLICY IF EXISTS player_mapping_queue_insert ON player_mapping_queue;
DROP POLICY IF EXISTS player_mapping_queue_update ON player_mapping_queue;

CREATE POLICY player_mapping_queue_select ON player_mapping_queue FOR SELECT TO authenticated USING (true);
CREATE POLICY player_mapping_queue_insert ON player_mapping_queue FOR INSERT TO authenticated
  WITH CHECK (am_i_super_admin() OR user_id = auth.uid());
CREATE POLICY player_mapping_queue_update ON player_mapping_queue FOR UPDATE TO authenticated
  USING (am_i_super_admin() OR user_id = auth.uid());
