-- Migration 042: message_reactions — emoji reactions on chat messages.
--
-- PK (message_id, player_id, emoji): one row per player per emoji per
-- message. The full row IS the primary key, so realtime DELETE payloads
-- (which carry PK columns only without REPLICA IDENTITY FULL) contain
-- everything the client needs to remove the reaction locally.
--
-- RLS mirrors messages (041): visibility through the parent message's room;
-- insert/delete only as one of your own players. No UPDATE policy — a
-- reaction is added or removed, never edited.
-- Reuses helpers from migration 014: am_i_group_member(gid), get_my_player_ids().

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id),
  player_id  TEXT NOT NULL REFERENCES players(id),
  emoji      TEXT NOT NULL CHECK (char_length(emoji) <= 16),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, player_id, emoji)
);

ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;

-- Visible if the parent message's room is visible (global, or a group you're in).
DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM messages m
      JOIN rooms r ON r.id = m.room_id
      WHERE m.id = message_reactions.message_id
        AND (r.kind = 'global' OR am_i_group_member(r.group_id))
    )
  );

-- React only as one of your own players, on a message you can see.
DROP POLICY IF EXISTS message_reactions_insert ON message_reactions;
CREATE POLICY message_reactions_insert ON message_reactions FOR INSERT TO authenticated
  WITH CHECK (
    player_id IN (SELECT get_my_player_ids())
    AND EXISTS (
      SELECT 1 FROM messages m
      JOIN rooms r ON r.id = m.room_id
      WHERE m.id = message_reactions.message_id
        AND (r.kind = 'global' OR am_i_group_member(r.group_id))
    )
  );

-- Un-react: remove your own reactions only.
DROP POLICY IF EXISTS message_reactions_delete ON message_reactions;
CREATE POLICY message_reactions_delete ON message_reactions FOR DELETE TO authenticated
  USING (player_id IN (SELECT get_my_player_ids()));

-- Broadcast INSERT/DELETE to subscribed clients (matches 040's idempotent pattern).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'message_reactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE message_reactions;
  END IF;
END $$;
