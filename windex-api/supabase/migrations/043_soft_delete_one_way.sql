-- Migration 043: soft-delete is one-way for non-admins.
--
-- 041's messages_soft_delete_only() allowed deleted_at to change in either
-- direction, so an author could un-delete their own message. Tighten: for
-- non-super-admins, deleted_at may only transition null -> not-null.
-- Super-admins keep both directions (moderation un-delete).
--
-- The trigger (messages_soft_delete_only_trg) is unchanged; only the
-- function body is replaced.

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

  IF OLD.deleted_at IS NOT NULL
     AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     AND NOT am_i_super_admin()
  THEN
    RAISE EXCEPTION 'soft-delete cannot be reversed';
  END IF;

  RETURN NEW;
END;
$$;
