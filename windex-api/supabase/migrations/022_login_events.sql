-- Durable login-event logging via SECURITY DEFINER triggers on auth.sessions.
--
-- Backstory: Supabase's platform-level auth log retains events for only 7
-- days. We want a queryable, indefinite audit trail of "who signed in,
-- when, from where" for compliance and debugging.
--
-- The investigation on 2026-05-10 (see Project_Context.md) found that the
-- documented `auth.audit_log_entries` table is empty on Supabase's hosted
-- platform — its dashboard auth log pulls from a separate telemetry
-- pipeline, not from this table. The supported Auth Hooks (custom-access-
-- token et al.) don't carry IP / user_agent in their payloads and add an
-- HTTP round-trip to every login.
--
-- `auth.sessions`, on the other hand, is populated in real time on this
-- project and already carries IP, user_agent, aal, and session timing on
-- each row. We attach AFTER triggers on INSERT/UPDATE/DELETE and copy the
-- relevant data to public.login_events.
--
-- Captured event types (event_type column):
--   'login_success'  — INSERT on auth.sessions (new session row)
--   'token_refresh'  — UPDATE on auth.sessions when refreshed_at changes
--   'logout'         — DELETE on auth.sessions (Supabase deletes the row
--                      on signOut). Note: a user-delete cascade also fires
--                      this, so a sudden burst of 'logout' rows can mean
--                      user-deletion-cascade rather than a literal logout
--                      action by the user.
--
-- NOT captured (gap, same as the hook approach would have had):
--   failed OTP attempts — no session row is created on a bad code, and no
--   Supabase hook fires for this either. The platform 7-day auth log is the
--   only visibility there.
--
-- event_type stays a plain TEXT column (no CHECK constraint) so future
-- event types can be added without a migration if we wire up other logging
-- paths later (e.g. client-side logging of failed OTP).

-- =============================================================================
-- 1. Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.login_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- nullable: a failed attempt that we someday log via another path may not
  -- have resolved to an auth user
  user_id       UUID NULL,
  -- TEXT, not UUID — players.id is a short string (Glide row-id shape or
  -- nanoid going forward), not a UUID. Matches the FK type on group_members.
  player_id     TEXT NULL REFERENCES public.players(id) ON DELETE SET NULL,
  email         TEXT NULL,
  event_type    TEXT NOT NULL,
  -- For session-triggered events this is auth.sessions.aal ('aal1' / 'aal2').
  -- It is the auth-assurance-level, not the method per se — Windex is
  -- OTP-only today so every successful login is 'aal1'. If we ever add
  -- MFA, aal2 will appear here. Other writers can use other strings.
  auth_method   TEXT NULL,
  user_agent    TEXT NULL,
  ip_address    INET NULL,
  error_message TEXT NULL,
  metadata      JSONB NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_login_events_occurred_at
  ON public.login_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_player
  ON public.login_events (player_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_event_type
  ON public.login_events (event_type, occurred_at DESC);

COMMENT ON TABLE public.login_events IS
  'Append-only audit log of authentication events. Populated by triggers on auth.sessions. See migration 022.';

-- =============================================================================
-- 2. RLS — super admin SELECT only, no INSERT/UPDATE/DELETE policy
-- =============================================================================
--
-- The trigger function is SECURITY DEFINER and runs as the function owner
-- (postgres on Supabase). The owner of public.login_events is also postgres
-- (created by this migration), and Postgres' default behavior is owner-
-- bypasses-RLS unless FORCE ROW LEVEL SECURITY is set — which it is not.
-- So the trigger can INSERT freely. Service role also bypasses RLS.
-- Authenticated users get nothing unless they're super admin (SELECT only).

ALTER TABLE public.login_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS login_events_select ON public.login_events;
CREATE POLICY login_events_select ON public.login_events
  FOR SELECT
  TO authenticated
  USING (am_i_super_admin());

-- No INSERT / UPDATE / DELETE policies on purpose. This is an append-only
-- audit log; the trigger inserts as owner; nobody else writes.

-- =============================================================================
-- 3. Trigger function
-- =============================================================================
--
-- One function, branches on TG_OP. Defense:
--   * Whole body wrapped in BEGIN/EXCEPTION WHEN OTHERS — auth flow must
--     never break because of logging failure. Failures land in postgres
--     logs via RAISE WARNING and we return normally.
--   * For UPDATE we early-return when refreshed_at didn't change, so
--     non-refresh UPDATEs (metadata bumps, refresh_token_counter increments
--     without a refreshed_at change, etc.) don't generate spurious rows.
--   * Email + player_id lookups are best-effort — if the auth user is
--     already gone (delete cascade) we still log the event with whatever
--     we have.

CREATE OR REPLACE FUNCTION public.log_auth_session_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event_type TEXT;
  v_email      TEXT;
  v_player_id  TEXT;
  v_user_id    UUID;
  v_aal        TEXT;
  v_user_agent TEXT;
  v_ip         INET;
  v_session_id UUID;
BEGIN
  BEGIN
    -- ─── Branch on TG_OP ─────────────────────────────────────────────────
    IF TG_OP = 'INSERT' THEN
      v_event_type := 'login_success';
      v_user_id    := NEW.user_id;
      v_aal        := NEW.aal::TEXT;
      v_user_agent := NEW.user_agent;
      v_ip         := NEW.ip;
      v_session_id := NEW.id;
    ELSIF TG_OP = 'UPDATE' THEN
      -- Only a real refresh — i.e. refreshed_at actually changed. Other
      -- UPDATEs on this row (e.g. refresh_token_counter bumps without a
      -- refreshed_at change) shouldn't produce token_refresh rows.
      IF NEW.refreshed_at IS NOT DISTINCT FROM OLD.refreshed_at THEN
        RETURN NEW;
      END IF;
      v_event_type := 'token_refresh';
      v_user_id    := NEW.user_id;
      v_aal        := NEW.aal::TEXT;
      v_user_agent := NEW.user_agent;
      v_ip         := NEW.ip;
      v_session_id := NEW.id;
    ELSIF TG_OP = 'DELETE' THEN
      v_event_type := 'logout';
      v_user_id    := OLD.user_id;
      v_aal        := OLD.aal::TEXT;
      v_user_agent := OLD.user_agent;
      v_ip         := OLD.ip;
      v_session_id := OLD.id;
    ELSE
      RETURN COALESCE(NEW, OLD);
    END IF;

    -- ─── Best-effort lookups ────────────────────────────────────────────
    SELECT email INTO v_email FROM auth.users WHERE id = v_user_id;
    SELECT id    INTO v_player_id FROM public.players WHERE user_id = v_user_id LIMIT 1;

    -- ─── Write the row ──────────────────────────────────────────────────
    INSERT INTO public.login_events (
      user_id, player_id, email, event_type, auth_method,
      user_agent, ip_address, metadata
    )
    VALUES (
      v_user_id,
      v_player_id,
      v_email,
      v_event_type,
      v_aal,
      v_user_agent,
      v_ip,
      jsonb_build_object('session_id', v_session_id, 'tg_op', TG_OP)
    );
  EXCEPTION WHEN OTHERS THEN
    -- Never block or fail the auth flow. Surface in postgres logs and
    -- continue. The audit log is best-effort; auth correctness comes first.
    RAISE WARNING 'log_auth_session_event(% on session %): %',
      TG_OP, COALESCE(NEW.id::TEXT, OLD.id::TEXT, '?'), SQLERRM;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.log_auth_session_event() IS
  'Append rows to public.login_events from auth.sessions INSERT/UPDATE/DELETE. SECURITY DEFINER + EXCEPTION WHEN OTHERS so it cannot break the auth flow.';

-- =============================================================================
-- 4. Triggers on auth.sessions
-- =============================================================================
--
-- Three AFTER triggers all calling the same function. The function branches
-- on TG_OP. Using AFTER (not BEFORE) so a trigger failure (which we
-- swallow anyway) cannot affect the underlying auth.sessions write.

DROP TRIGGER IF EXISTS log_auth_session_insert ON auth.sessions;
CREATE TRIGGER log_auth_session_insert
  AFTER INSERT ON auth.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.log_auth_session_event();

DROP TRIGGER IF EXISTS log_auth_session_update ON auth.sessions;
CREATE TRIGGER log_auth_session_update
  AFTER UPDATE ON auth.sessions
  FOR EACH ROW
  WHEN (NEW.refreshed_at IS DISTINCT FROM OLD.refreshed_at)
  EXECUTE FUNCTION public.log_auth_session_event();

DROP TRIGGER IF EXISTS log_auth_session_delete ON auth.sessions;
CREATE TRIGGER log_auth_session_delete
  AFTER DELETE ON auth.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.log_auth_session_event();
