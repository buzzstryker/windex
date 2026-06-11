-- Migration 045: chat-images bucket + policies — photo attachments in chat.
--
-- Unlike group-images (created via the dashboard 2026-03-26 with wide-open
-- authenticated INSERT, then retro-tightened in migration 026 — see that
-- file's header for the lesson), this bucket is migration-managed from
-- birth: config and policies live here, in one reviewable place.
--
-- Bucket: public read (chat bubbles render via plain public URLs, mirroring
-- how groups.logo_url is consumed), 5 MiB cap, jpeg/png/webp. The client
-- re-encodes to JPEG before upload; png/webp stay allowed for future or
-- manual writes.
--
-- Path convention: <player_id>/<uuid>.jpg — the INSERT policy requires the
-- first folder segment to be one of the caller's own player ids
-- (get_my_player_ids() from migration 014, same helper the chat RLS uses).
--
-- No UPDATE policy (objects immutable, matching the messages trigger).
-- No DELETE policy in v1 — soft-deleted messages orphan their storage
-- objects; accepted debt, same class as the retained message rows.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-images',
  'chat-images',
  true,
  5242880, -- 5 MiB
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- ── Policies on storage.objects ───────────────────────────────────────────

DROP POLICY IF EXISTS "chat_images_select" ON storage.objects;
CREATE POLICY "chat_images_select" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'chat-images');

DROP POLICY IF EXISTS "chat_images_insert" ON storage.objects;
CREATE POLICY "chat_images_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat-images'
    AND (storage.foldername(name))[1] IN (SELECT get_my_player_ids())
  );

-- No UPDATE or DELETE policies: chat-image objects are write-once in v1.
