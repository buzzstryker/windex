-- User activity event logging.
--
-- Append-only audit of in-app user activity, parallel to migration 022's
-- login_events table. Where login_events captures auth-layer events via
-- triggers on auth.sessions, user_events captures application-layer events
-- written directly from windex-expo via supabase-js INSERT under RLS.
--
-- Initial event types written by the client today (2026-05-11):
--   'group_switch'      — fires when the user changes selectedGroup
--   'view_leaderboard'  — fires on Standings tab mount + group/season change
--   'view_rounds_list'  — fires on Rounds tab mount + group/season change
--
-- event_type is plain TEXT with no CHECK constraint so additional event
-- types can be added without a schema migration. The client (lib/userEvents
-- .ts in windex-expo) is the source of truth for valid values today.
--
-- player_id is denormalized for index efficiency on per-player history
-- queries; it's a TEXT FK to public.players (matches the rest of the
-- schema, where players.id is a 20-char string, not a UUID). user_id has
-- no FK by precedent — same call as login_events and migration 020's
-- trigger, which avoid cross-schema FKs to auth.* because Supabase's
-- managed schemas can shift between upgrades.

-- =============================================================================
-- 1. Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- auth.uid() of the actor. The INSERT RLS policy enforces
  -- user_id = auth.uid(), so a client cannot fabricate events as another
  -- user. No FK to auth.users for the upgrade-safety reason above.
  user_id     UUID NOT NULL,
  -- Denormalized convenience for "who did this" queries. Nullable because
  -- the client may not have it cached yet (e.g. before GroupContext loads
  -- get_my_player_ids).
  player_id   TEXT NULL REFERENCES public.players(id) ON DELETE SET NULL,
  event_type  TEXT NOT NULL,
  -- Dominant filter columns for any query we'd actually run. Pulled out of
  -- metadata into first-class columns so the indexes below can target them.
  group_id    TEXT NULL REFERENCES public.groups(id)  ON DELETE SET NULL,
  season_id   TEXT NULL REFERENCES public.seasons(id) ON DELETE SET NULL,
  -- Free-form per-event details. For 'group_switch' this carries
  -- {from_group_id: <id>}; otherwise typically empty.
  metadata    JSONB NULL DEFAULT '{}'::JSONB
);

COMMENT ON TABLE public.user_events IS
  'Append-only audit log of in-app user activity. Written client-side via supabase-js INSERT under RLS. See migration 023.';

-- =============================================================================
-- 2. Indexes
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_user_events_occurred_at
  ON public.user_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_events_player_occurred
  ON public.user_events (player_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_events_event_type_occurred
  ON public.user_events (event_type, occurred_at DESC);

-- Partial: only rows with a group_id are interesting for group-scoped
-- queries, and most events will have one. Cheaper than full when the
-- group_id is NULL on a few outliers.
CREATE INDEX IF NOT EXISTS idx_user_events_group_occurred
  ON public.user_events (group_id, occurred_at DESC)
  WHERE group_id IS NOT NULL;

-- =============================================================================
-- 3. RLS
-- =============================================================================
--
-- Append-only audit: super admin can read everything; any authenticated
-- user can INSERT but only as themselves (user_id = auth.uid()); nobody
-- can UPDATE or DELETE through RLS (no policies → no access). Service
-- role bypasses RLS by default if we ever need to do maintenance.

ALTER TABLE public.user_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_events_select_super_admin ON public.user_events;
CREATE POLICY user_events_select_super_admin ON public.user_events
  FOR SELECT
  TO authenticated
  USING (am_i_super_admin());

DROP POLICY IF EXISTS user_events_insert_own ON public.user_events;
CREATE POLICY user_events_insert_own ON public.user_events
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- No UPDATE / DELETE policies on purpose. Append-only.
