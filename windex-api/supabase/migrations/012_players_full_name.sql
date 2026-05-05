-- v1 users.name (real name) preserved separately; v1 users.username → players.display_name (shown in standings).
-- Standings and competition views use display_name only.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS full_name TEXT;

COMMENT ON COLUMN players.full_name IS 'Optional real name (e.g. from Glide Identity/Name). Standings and UI use display_name; full_name is profile metadata only.';
