-- Activity events consolidated view + RPC helpers for the App Activity tab.
--
-- This migration is read-only / additive — no changes to login_events or
-- user_events. It creates:
--
--   1. public.activity_events  — a SECURITY INVOKER view that UNION ALLs
--      login_events (excluding token_refresh) and user_events into one
--      consolidated activity feed. The activity tab UI consumes this
--      view directly via three RPC helpers below.
--
--   2. get_players_with_last_activity()  — one row per player, LEFT JOINed
--      to their most recent activity_events entry. Drives the list page.
--
--   3. get_player_activity_timeline(player_id, limit)  — reverse-chrono
--      events for a single player, with group + season names resolved.
--      Drives the detail page timeline.
--
--   4. get_player_activity_summary(player_id)  — aggregate counts for the
--      detail page summary block.
--
-- RLS strategy:
--   * The view is created `WITH (security_invoker = true)` so it executes
--     with the caller's identity and inherits RLS from login_events and
--     user_events — both of which already gate SELECT to `am_i_super_admin()`.
--   * The RPCs are SECURITY INVOKER for the same reason — non-super-admin
--     callers will see zero rows from activity_events when the functions
--     query it, even though the functions are EXECUTE-able by any
--     authenticated user (which they have to be for PostgREST to call them).
--
-- token_refresh is excluded at the view level (single point of truth) so
-- every downstream consumer automatically filters it without needing to
-- remember.

-- =============================================================================
-- 1. activity_events view
-- =============================================================================

CREATE OR REPLACE VIEW public.activity_events
WITH (security_invoker = true) AS
SELECT
  'login_events'::TEXT AS source_table,
  id,
  occurred_at,
  user_id,
  player_id,
  event_type,
  NULL::TEXT AS group_id,
  NULL::TEXT AS season_id,
  metadata
FROM public.login_events
WHERE event_type <> 'token_refresh'
UNION ALL
SELECT
  'user_events'::TEXT AS source_table,
  id,
  occurred_at,
  user_id,
  player_id,
  event_type,
  group_id,
  season_id,
  metadata
FROM public.user_events;

COMMENT ON VIEW public.activity_events IS
  'Consolidated activity feed: UNIONs login_events (minus token_refresh) and user_events. SECURITY INVOKER — RLS from underlying tables (super-admin SELECT only) applies. See migration 024.';

-- =============================================================================
-- 2. get_players_with_last_activity()
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_players_with_last_activity()
RETURNS TABLE (
  player_id       TEXT,
  display_name    TEXT,
  email           TEXT,
  last_event_at   TIMESTAMPTZ,
  last_event_type TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    p.id           AS player_id,
    p.display_name,
    p.email,
    latest.occurred_at AS last_event_at,
    latest.event_type  AS last_event_type
  FROM public.players p
  LEFT JOIN LATERAL (
    SELECT occurred_at, event_type
    FROM public.activity_events
    WHERE player_id = p.id
    ORDER BY occurred_at DESC
    LIMIT 1
  ) latest ON true
  ORDER BY latest.occurred_at DESC NULLS LAST, p.display_name ASC;
$$;

COMMENT ON FUNCTION public.get_players_with_last_activity() IS
  'List every player with their most-recent activity_events entry (LEFT JOIN — NULL for players with no events). Sort: last_event_at DESC NULLS LAST, display_name ASC. Powers the /activity list page.';

-- =============================================================================
-- 3. get_player_activity_timeline(p_player_id, p_limit)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_player_activity_timeline(
  p_player_id TEXT,
  p_limit     INT DEFAULT 100
)
RETURNS TABLE (
  id                 UUID,
  occurred_at        TIMESTAMPTZ,
  event_type         TEXT,
  source_table       TEXT,
  group_id           TEXT,
  group_name         TEXT,
  season_id          TEXT,
  season_start_date  TEXT,
  season_end_date    TEXT,
  metadata           JSONB,
  from_group_id      TEXT,
  from_group_name    TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    ae.id,
    ae.occurred_at,
    ae.event_type,
    ae.source_table,
    ae.group_id,
    g.name      AS group_name,
    ae.season_id,
    s.start_date AS season_start_date,
    s.end_date   AS season_end_date,
    ae.metadata,
    (ae.metadata->>'from_group_id') AS from_group_id,
    fg.name     AS from_group_name
  FROM public.activity_events ae
  LEFT JOIN public.groups  g  ON g.id  = ae.group_id
  LEFT JOIN public.seasons s  ON s.id  = ae.season_id
  LEFT JOIN public.groups  fg ON fg.id = (ae.metadata->>'from_group_id')
  WHERE ae.player_id = p_player_id
  ORDER BY ae.occurred_at DESC
  LIMIT GREATEST(p_limit, 1);
$$;

COMMENT ON FUNCTION public.get_player_activity_timeline(TEXT, INT) IS
  'Reverse-chrono timeline for one player, with group + season names resolved and the group_switch from-group resolved from metadata. Powers the /activity/:player_id detail page.';

-- =============================================================================
-- 4. get_player_activity_summary(p_player_id)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_player_activity_summary(p_player_id TEXT)
RETURNS TABLE (
  total_events       BIGINT,
  first_event_at     TIMESTAMPTZ,
  last_event_at      TIMESTAMPTZ,
  event_type_counts  JSONB
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH evs AS (
    SELECT occurred_at, event_type
    FROM public.activity_events
    WHERE player_id = p_player_id
  ),
  counts AS (
    SELECT event_type, COUNT(*)::INT AS cnt
    FROM evs
    GROUP BY event_type
  )
  SELECT
    (SELECT COUNT(*) FROM evs)::BIGINT          AS total_events,
    (SELECT MIN(occurred_at) FROM evs)          AS first_event_at,
    (SELECT MAX(occurred_at) FROM evs)          AS last_event_at,
    COALESCE(
      (SELECT jsonb_object_agg(event_type, cnt) FROM counts),
      '{}'::jsonb
    ) AS event_type_counts;
$$;

COMMENT ON FUNCTION public.get_player_activity_summary(TEXT) IS
  'Aggregate counts for one player: total events, first/last seen timestamps, and a {event_type: count} jsonb breakdown. Powers the summary block on /activity/:player_id.';

-- =============================================================================
-- 5. Grants — let authenticated users call the RPCs via PostgREST
-- =============================================================================
--
-- The functions themselves are SECURITY INVOKER, so RLS gates the data they
-- return. Granting EXECUTE to `authenticated` just means PostgREST will
-- expose them at /rest/v1/rpc/<name>; a non-super-admin who calls them will
-- get back rows where activity_events resolves to empty.

GRANT EXECUTE ON FUNCTION public.get_players_with_last_activity()              TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_player_activity_timeline(TEXT, INT)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_player_activity_summary(TEXT)              TO authenticated;
