-- Migration 041: Chat RLS — rooms / messages / room_reads.
--
-- Reuses existing helper functions from migration 014 (do NOT recreate):
--   am_i_super_admin(), am_i_group_member(gid), get_my_player_ids().
--
-- Policy summary:
--   rooms       — anyone authenticated reads; only super-admin writes.
--   messages    — read a room you can see (global, or a group you're in);
--                 insert as one of your own players into a visible room;
--                 update only your own (or super-admin), and a trigger
--                 restricts UPDATE to the deleted_at column (soft-delete only);
--                 no DELETE policy → hard delete is forbidden.
--   room_reads  — full access to your own rows only.

ALTER TABLE rooms      ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_reads ENABLE ROW LEVEL SECURITY;

-- ── rooms ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS rooms_select ON rooms;
CREATE POLICY rooms_select ON rooms FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS rooms_insert ON rooms;
CREATE POLICY rooms_insert ON rooms FOR INSERT TO authenticated
  WITH CHECK (am_i_super_admin());

DROP POLICY IF EXISTS rooms_update ON rooms;
CREATE POLICY rooms_update ON rooms FOR UPDATE TO authenticated
  USING (am_i_super_admin())
  WITH CHECK (am_i_super_admin());

DROP POLICY IF EXISTS rooms_delete ON rooms;
CREATE POLICY rooms_delete ON rooms FOR DELETE TO authenticated
  USING (am_i_super_admin());

-- ── messages ─────────────────────────────────────────────────────────────
-- Visible if the room is global or you're a member of its group.
DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM rooms r
      WHERE r.id = messages.room_id
        AND (r.kind = 'global' OR am_i_group_member(r.group_id))
    )
  );

-- Insert only as one of your own players, into a room you can see.
DROP POLICY IF EXISTS messages_insert ON messages;
CREATE POLICY messages_insert ON messages FOR INSERT TO authenticated
  WITH CHECK (
    author_player_id IN (SELECT get_my_player_ids())
    AND EXISTS (
      SELECT 1 FROM rooms r
      WHERE r.id = messages.room_id
        AND (r.kind = 'global' OR am_i_group_member(r.group_id))
    )
  );

-- Update your own messages (or super-admin). The trigger below restricts
-- which columns may actually change.
DROP POLICY IF EXISTS messages_update ON messages;
CREATE POLICY messages_update ON messages FOR UPDATE TO authenticated
  USING (
    am_i_super_admin()
    OR author_player_id IN (SELECT get_my_player_ids())
  );

-- No DELETE policy: hard delete is forbidden; removal is soft-delete only.

-- BEFORE UPDATE trigger: only deleted_at may change. Any other column edit
-- raises, enforcing soft-delete-only at the row level (ships with the schema
-- even though no Stage 1 UI performs updates).
CREATE OR REPLACE FUNCTION messages_soft_delete_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id               IS DISTINCT FROM OLD.id
     OR NEW.room_id          IS DISTINCT FROM OLD.room_id
     OR NEW.author_player_id IS DISTINCT FROM OLD.author_player_id
     OR NEW.body             IS DISTINCT FROM OLD.body
     OR NEW.attachment_url   IS DISTINCT FROM OLD.attachment_url
     OR NEW.created_at       IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'messages are immutable except deleted_at (soft-delete only)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_soft_delete_only_trg ON messages;
CREATE TRIGGER messages_soft_delete_only_trg
  BEFORE UPDATE ON messages
  FOR EACH ROW
  EXECUTE FUNCTION messages_soft_delete_only();

-- ── room_reads ───────────────────────────────────────────────────────────
-- Full access to your own watermark rows only.
DROP POLICY IF EXISTS room_reads_all ON room_reads;
CREATE POLICY room_reads_all ON room_reads FOR ALL TO authenticated
  USING (player_id IN (SELECT get_my_player_ids()))
  WITH CHECK (player_id IN (SELECT get_my_player_ids()));
