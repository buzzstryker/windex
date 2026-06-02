-- Migration 040: Chat schema (Stage 1) — rooms / messages / room_reads.
--
-- Full v1 schema for in-app chat. Only the single 'global' text room is wired
-- to UI in Stage 1; the schema already supports group rooms, soft-delete,
-- attachments, and per-player unread tracking (room_reads) for later stages.
--
-- RLS lives in the companion migration 041. Realtime is enabled here so the
-- `messages` table broadcasts INSERTs to subscribed clients.

-- ── rooms ────────────────────────────────────────────────────────────────
-- One row per chat room. 'global' is the app-wide text room; 'group' rooms
-- are scoped to a single group via group_id.
CREATE TABLE IF NOT EXISTS rooms (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('global', 'group')),
  group_id   TEXT REFERENCES groups(id),          -- NULL for the global room
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the single global text room.
INSERT INTO rooms (id, kind, group_id, name)
VALUES ('global', 'global', NULL, 'Chat')
ON CONFLICT (id) DO NOTHING;

-- ── messages ─────────────────────────────────────────────────────────────
-- A message is authored by a player into a room. Either body or attachment_url
-- must be present. deleted_at drives soft-delete (Stage 1 never sets it).
CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  room_id          TEXT NOT NULL REFERENCES rooms(id),
  author_player_id TEXT NOT NULL REFERENCES players(id),
  body             TEXT,
  attachment_url   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  CHECK (body IS NOT NULL OR attachment_url IS NOT NULL)
);

-- Newest-first reads within a room (the chat list paginates DESC).
CREATE INDEX IF NOT EXISTS messages_room_created_idx
  ON messages (room_id, created_at DESC);
-- Partial-friendly lookups by soft-delete state.
CREATE INDEX IF NOT EXISTS messages_deleted_at_idx
  ON messages (deleted_at);

-- ── room_reads ───────────────────────────────────────────────────────────
-- Per-(player, room) read watermark for unread badges (later stage).
CREATE TABLE IF NOT EXISTS room_reads (
  player_id    TEXT REFERENCES players(id),
  room_id      TEXT REFERENCES rooms(id),
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, room_id)
);

-- ── realtime ─────────────────────────────────────────────────────────────
-- Broadcast INSERT/UPDATE/DELETE on messages to subscribed clients. Wrapped
-- so re-running against an already-configured publication is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE messages;
  END IF;
END $$;
