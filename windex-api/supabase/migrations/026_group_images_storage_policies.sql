-- Migration 026: group-images bucket security tightening + size/MIME limits.
--
-- Background: the public `group-images` Storage bucket was created via the
-- Supabase dashboard 2026-03-26 (no prior migration). It already holds the
-- three production logos (`windex-cup.png`, `yc-windex.png`, `catta-rage.jpg`)
-- and `groups.logo_url` for both active groups points to it. Pre-existing
-- policies were:
--   storage.buckets row:
--     file_size_limit = NULL (unlimited)
--     allowed_mime_types = NULL (any)
--   storage.objects RLS:
--     "Allow public select"  — SELECT to public,        bucket_id = 'group-images'
--     "Allow public uploads" — INSERT to authenticated, bucket_id = 'group-images'
--
-- The INSERT policy was effectively wide-open: any signed-in user (including
-- ordinary league members) could upload arbitrary files. This migration
-- restricts INSERT/UPDATE/DELETE to super admins (via am_i_super_admin() from
-- migration 014), caps file size at 10 MiB (grandfathers the existing
-- 7.7 MB windex-cup.png), and limits mime types to jpeg/png/webp. The public
-- SELECT policy is intentionally preserved so logos render unauthenticated on
-- the player surfaces (Drawer, GroupSelector, group cards).

-- ── Bucket config ─────────────────────────────────────────────────────────
UPDATE storage.buckets
SET
  file_size_limit = 10485760, -- 10 MiB
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp']
WHERE id = 'group-images';

-- ── Policies on storage.objects ───────────────────────────────────────────
DROP POLICY IF EXISTS "Allow public uploads" ON storage.objects;

-- Idempotent re-create in case this migration is re-run.
DROP POLICY IF EXISTS "group_images_insert" ON storage.objects;
DROP POLICY IF EXISTS "group_images_update" ON storage.objects;
DROP POLICY IF EXISTS "group_images_delete" ON storage.objects;

CREATE POLICY "group_images_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'group-images' AND am_i_super_admin());

CREATE POLICY "group_images_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'group-images' AND am_i_super_admin())
  WITH CHECK (bucket_id = 'group-images' AND am_i_super_admin());

CREATE POLICY "group_images_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'group-images' AND am_i_super_admin());

-- "Allow public select" is preserved — required for unauthenticated logo
-- rendering on player surfaces.
