-- Step 1: Add is_super_admin to players
ALTER TABLE players ADD COLUMN IF NOT EXISTS is_super_admin SMALLINT NOT NULL DEFAULT 0;

-- Step 2: Set Buzz Stryker as super admin
UPDATE players SET is_super_admin = 1 WHERE lower(display_name) = 'buzz'
  OR lower(email) LIKE '%buzzstryker%';

-- Step 3: Normalize group_members.role values
UPDATE group_members SET role = 'admin' WHERE lower(role) = 'admin';
UPDATE group_members SET role = 'member' WHERE role NOT IN ('admin', 'member');

-- Step 4: Add CHECK constraint (drop first if exists to be safe)
DO $$ BEGIN
  ALTER TABLE group_members DROP CONSTRAINT IF EXISTS group_members_role_check;
  ALTER TABLE group_members ADD CONSTRAINT group_members_role_check CHECK (role IN ('admin', 'member'));
END $$;

-- Step 5: Helper function — get_my_player_ids() returns all player.id for current auth user
CREATE OR REPLACE FUNCTION get_my_player_ids()
RETURNS SETOF TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT id FROM players WHERE user_id = auth.uid();
$$;

-- Step 6: Helper function — am_i_super_admin()
CREATE OR REPLACE FUNCTION am_i_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (SELECT 1 FROM players WHERE user_id = auth.uid() AND is_super_admin = 1);
$$;

-- Step 7: Helper function — am_i_group_admin(group_id)
CREATE OR REPLACE FUNCTION am_i_group_admin(gid TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM group_members gm
    WHERE gm.group_id = gid
      AND gm.role = 'admin'
      AND gm.player_id IN (SELECT id FROM players WHERE user_id = auth.uid())
  );
$$;

-- Step 8: Helper function — am_i_group_member(group_id)
CREATE OR REPLACE FUNCTION am_i_group_member(gid TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM group_members gm
    WHERE gm.group_id = gid
      AND gm.player_id IN (SELECT id FROM players WHERE user_id = auth.uid())
  );
$$;

-- Step 9: Helper function — get_my_player_id() returns first player.id for current auth user
CREATE OR REPLACE FUNCTION get_my_player_id()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT id FROM players WHERE user_id = auth.uid() LIMIT 1;
$$;
