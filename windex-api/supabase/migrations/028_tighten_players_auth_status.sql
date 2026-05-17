-- Migration 028: tighten get_players_auth_status() has_signed_in derivation.
--
-- Migration 027 derived has_signed_in purely from auth.users:
--   (email_confirmed_at IS NOT NULL OR last_sign_in_at IS NOT NULL)
--
-- That is over-permissive. Phantom sessions from link scanners, email
-- prefetchers, or a future auth regression can populate email_confirmed_at /
-- last_sign_in_at without the user ever having actually used the app — which
-- made the admin Players page show a green "signed in" pill for people who
-- were only ever invited.
--
-- This migration additionally requires corroborating evidence: at least one
-- row in public.activity_events (migration 024) keyed to the player. That
-- view is login_events (minus token_refresh) UNION ALL user_events — rows
-- there are written by triggers and client calls only when the user actually
-- does something in the app. So has_signed_in now means "auth says signed in
-- AND we have real activity to back it up".
--
-- Nothing else about the function changes: same arg list (none), same return
-- shape, same plpgsql / STABLE / SECURITY DEFINER / search_path, same
-- am_i_super_admin() gate, same COMMENT, same GRANT. Only the has_signed_in
-- column expression is tightened.
--
-- activity_events is a SECURITY INVOKER view, but this function is
-- SECURITY DEFINER and already gated at the top by am_i_super_admin(), so
-- the EXISTS probe sees the data it needs and only super-admins reach it.

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
      (
        (u.email_confirmed_at IS NOT NULL OR u.last_sign_in_at IS NOT NULL)
        AND EXISTS (
          SELECT 1
          FROM public.activity_events ae
          WHERE ae.player_id = p.id
        )
      ),
      u.invited_at,
      u.email_confirmed_at,
      u.last_sign_in_at
    FROM public.players p
    LEFT JOIN auth.users u ON u.id = p.user_id;
END;
$$;

COMMENT ON FUNCTION public.get_players_auth_status() IS
  'Returns onboarding state per player for the admin UI. Super-admin only; '
  'non-admins get zero rows. Joins players → auth.users on user_id. '
  'has_signed_in requires both an auth signal AND >=1 activity_events row '
  '(migration 028 — guards against phantom auth sessions).';

GRANT EXECUTE ON FUNCTION public.get_players_auth_status() TO authenticated;
