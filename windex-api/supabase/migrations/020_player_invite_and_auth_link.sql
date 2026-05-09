-- Player invite + auto auth-linking
--
-- Supports the unified "Add Player" admin flow (invite-player Edge Function +
-- windex-admin UI). A super admin can create a player row up front (without
-- an auth user) and optionally fire an invite email; the new auth user is
-- linked to that players row automatically on first sign-in.
--
-- Three pieces in this migration:
--
--   1. Relax players schema so the row can exist before the auth user does.
--      The composite PK (id, user_id) and NOT NULL user_id were holdovers
--      from a per-tenant design that the super-admin overhaul (014/015)
--      already moved past. id is globally unique on its own, so PK becomes
--      just (id) and user_id becomes nullable. FK switches to SET NULL so
--      deleting an auth user unlinks the player rather than deleting the
--      record (and any historical scores attribution would break).
--
--   2. link_player_on_auth_signup() trigger function (SECURITY DEFINER) that
--      runs AFTER INSERT on auth.users. If a players row exists with a
--      matching email and user_id IS NULL, it links them. This is the FIRST
--      auth.users trigger in this project — there has never been a
--      handle_new_user trigger here, despite earlier doc claims.
--
--   3. One-time backfill: link any pre-existing email matches at deploy time
--      and RAISE NOTICE the row count. Run unconditionally — safe no-op if
--      nothing matches.

-- =============================================================================
-- 1. Relax the players schema
-- =============================================================================

-- Drop composite PK so we can switch to (id) and allow nulls in user_id.
ALTER TABLE players DROP CONSTRAINT IF EXISTS players_pkey;

-- Make user_id nullable so a super-admin can create a player ahead of the
-- invite acceptance.
ALTER TABLE players ALTER COLUMN user_id DROP NOT NULL;

-- New PK: id alone. id is a globally-unique TEXT (Glide row IDs historically;
-- nanoid-style 20-char strings going forward).
ALTER TABLE players ADD PRIMARY KEY (id);

-- Switch the FK behavior: ON DELETE SET NULL instead of CASCADE. If an auth
-- user is removed, we want to keep the player record (and their historical
-- score rows still resolve via player_id) but drop the link.
ALTER TABLE players DROP CONSTRAINT IF EXISTS players_user_id_fkey;
ALTER TABLE players
  ADD CONSTRAINT players_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- =============================================================================
-- 2. Auth-link trigger
-- =============================================================================

CREATE OR REPLACE FUNCTION link_player_on_auth_signup()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  match_count INT;
  target_id   TEXT;
BEGIN
  -- Defensive: skip if email is null (shouldn't happen with email auth)
  IF NEW.email IS NULL THEN
    RETURN NEW;
  END IF;

  -- Count case-insensitive email matches that are unlinked.
  SELECT count(*) INTO match_count
    FROM public.players
   WHERE lower(email) = lower(NEW.email)
     AND user_id IS NULL;

  IF match_count = 0 THEN
    -- No pre-existing pending invite. Leave the auth user unlinked — this
    -- is also how dev accounts (e.g. dev@lateaddgolf.com) behave.
    RETURN NEW;
  END IF;

  IF match_count > 1 THEN
    RAISE NOTICE
      'link_player_on_auth_signup: % unlinked players rows match email %; linking the oldest by created_at',
      match_count, NEW.email;
  END IF;

  -- Pick the oldest by created_at (tie-break by id for determinism).
  SELECT id INTO target_id
    FROM public.players
   WHERE lower(email) = lower(NEW.email)
     AND user_id IS NULL
   ORDER BY created_at ASC NULLS LAST, id ASC
   LIMIT 1;

  UPDATE public.players
     SET user_id    = NEW.id,
         updated_at = now()
   WHERE id = target_id;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION link_player_on_auth_signup() IS
  'Auto-links a pending players row to a new auth user by email match. Fires AFTER INSERT on auth.users.';

DROP TRIGGER IF EXISTS link_player_on_auth_signup ON auth.users;
CREATE TRIGGER link_player_on_auth_signup
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION link_player_on_auth_signup();

-- =============================================================================
-- 3. One-time backfill
-- =============================================================================

DO $$
DECLARE
  linked INT;
BEGIN
  WITH candidates AS (
    SELECT DISTINCT ON (lower(p.email))
      p.id   AS player_id,
      u.id   AS user_id
    FROM public.players p
    JOIN auth.users u ON lower(u.email) = lower(p.email)
    WHERE p.user_id IS NULL
      AND p.email IS NOT NULL
    ORDER BY lower(p.email), p.created_at ASC NULLS LAST, p.id ASC
  )
  UPDATE public.players p
     SET user_id    = c.user_id,
         updated_at = now()
    FROM candidates c
   WHERE p.id = c.player_id;

  GET DIAGNOSTICS linked = ROW_COUNT;
  RAISE NOTICE 'link_player_on_auth_signup backfill: % players rows linked to existing auth users', linked;
END $$;
