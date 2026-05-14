-- Migration 027: get_players_auth_status() RPC for admin UI affordance gating.
--
-- The windex-admin Players page needs to know each player's current onboarding
-- state to decide which button to render:
--   - user_id IS NULL                                  → "Send Invite"
--   - user_id IS NOT NULL + email_confirmed_at NULL
--     + last_sign_in_at NULL                           → "Invited ✓" + "Send Again"
--   - user_id IS NOT NULL + (confirmed OR signed in)   → "Invited ✓" (no button)
--
-- The state lives partly on `public.players` (user_id) and partly on
-- `auth.users` (email_confirmed_at, last_sign_in_at, invited_at). PostgREST
-- cannot reach `auth.*` directly, so this SECURITY DEFINER function does the
-- join server-side and returns a small per-player status row.
--
-- Gated by am_i_super_admin() (migration 014) — non-super-admins get zero
-- rows, not an error, so the UI degrades gracefully.

CREATE OR REPLACE FUNCTION public.get_players_auth_status()
RETURNS TABLE(
  player_id           TEXT,
  has_signed_in       BOOLEAN,
  invited_at          TIMESTAMPTZ,
  email_confirmed_at  TIMESTAMPTZ,
  last_sign_in_at     TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  IF NOT public.am_i_super_admin() THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT
      p.id,
      (u.email_confirmed_at IS NOT NULL OR u.last_sign_in_at IS NOT NULL),
      u.invited_at,
      u.email_confirmed_at,
      u.last_sign_in_at
    FROM public.players p
    LEFT JOIN auth.users u ON u.id = p.user_id;
END;
$$;

COMMENT ON FUNCTION public.get_players_auth_status() IS
  'Returns onboarding state per player for the admin UI. Super-admin only; '
  'non-admins get zero rows. Joins players → auth.users on user_id.';

GRANT EXECUTE ON FUNCTION public.get_players_auth_status() TO authenticated;
