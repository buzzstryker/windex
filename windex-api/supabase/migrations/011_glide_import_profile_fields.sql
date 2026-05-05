-- Glide import: store source profile data on queue and optional contact/display on players.
-- Ingest can send source_email, source_venmo_handle, source_photo_url, source_is_active per score;
-- queue preserves them for admin review and for copying to players on resolve.

ALTER TABLE player_mapping_queue
  ADD COLUMN IF NOT EXISTS source_email TEXT,
  ADD COLUMN IF NOT EXISTS source_venmo_handle TEXT,
  ADD COLUMN IF NOT EXISTS source_photo_url TEXT,
  ADD COLUMN IF NOT EXISTS source_is_active SMALLINT,
  ADD COLUMN IF NOT EXISTS source_role TEXT;

COMMENT ON COLUMN player_mapping_queue.source_email IS 'From source (e.g. Glide Identity/Email); preserved for matching and display.';
COMMENT ON COLUMN player_mapping_queue.source_venmo_handle IS 'From source (e.g. Glide Venmo Handle).';
COMMENT ON COLUMN player_mapping_queue.source_photo_url IS 'From source (e.g. Glide Identity/Photo).';
COMMENT ON COLUMN player_mapping_queue.source_is_active IS 'From source (e.g. Glide Is Active); 1 active, 0 inactive.';
COMMENT ON COLUMN player_mapping_queue.source_role IS 'From source (e.g. Glide Identity/Role); can inform group_members.role on resolve.';

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS venmo_handle TEXT,
  ADD COLUMN IF NOT EXISTS photo_url TEXT;

COMMENT ON COLUMN players.email IS 'Optional contact email; can be set from Glide import on create/resolve.';
COMMENT ON COLUMN players.venmo_handle IS 'Optional Venmo handle; can be set from Glide import.';
COMMENT ON COLUMN players.photo_url IS 'Optional profile photo URL; can be set from Glide import.';
