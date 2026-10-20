-- Migration 061: read RPCs for the leaderboard.
--
--   get_season_standings(group, season)  one season: snapshot if closed, live if
--                                        open, plus the season's match count
--   get_leaderboard_bootstrap(group?)    everything app open needs, in one call;
--                                        replaces groups -> seasons -> get-standings
--                                        and GroupContext's identity lookups
--   get_all_time_standings(group)        season_standings_final for closed seasons
--                                        UNION ALL live season_standings for open
--                                        ones, summed per player
--
-- All SECURITY INVOKER: base-table and view RLS apply to the caller. The view is
-- security_invoker since 057. Dates are compared as TEXT 'YYYY-MM-DD', exactly as
-- the client does today (seasons.start_date / end_date are TEXT, 001).
-- The existing edge functions (groups, seasons, get-standings, events) are not
-- touched; old app bundles keep using them.

CREATE OR REPLACE FUNCTION public.get_season_standings(p_group_id TEXT, p_season_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_season public.seasons%ROWTYPE;
  v_rows   JSONB;
  v_count  INT;
BEGIN
  SELECT * INTO v_season FROM public.seasons
   WHERE id = p_season_id AND group_id = p_group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'get_season_standings: season % not found in group %', p_season_id, p_group_id
      USING ERRCODE = 'P0002';
  END IF;

  -- rank = row_number() by points, player_id as a stable tie-break.
  IF v_season.closed_at IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'player_id', r.player_id, 'player_name', p.display_name, 'full_name', p.full_name,
             'rounds_played', r.rounds_played, 'wins', r.wins, 'losses', r.losses, 'ties', r.ties,
             'total_points', r.total_points, 'rank', r.rnk) ORDER BY r.rnk), '[]'::jsonb)
      INTO v_rows
      FROM (SELECT f.player_id, f.rounds_played, f.wins, f.losses, f.ties, f.total_points,
                   row_number() OVER (ORDER BY f.total_points DESC, f.player_id) AS rnk
              FROM public.season_standings_final f
             WHERE f.season_id = p_season_id) r
      LEFT JOIN public.players p ON p.id = r.player_id;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'player_id', r.player_id, 'player_name', p.display_name, 'full_name', p.full_name,
             'rounds_played', r.rounds_played, 'wins', r.wins, 'losses', r.losses, 'ties', r.ties,
             'total_points', r.total_points, 'rank', r.rnk) ORDER BY r.rnk), '[]'::jsonb)
      INTO v_rows
      FROM (SELECT v.player_id, v.rounds_played, v.wins, v.losses, v.ties, v.total_points,
                   row_number() OVER (ORDER BY v.total_points DESC, v.player_id) AS rnk
              FROM public.season_standings v
             WHERE v.season_id = p_season_id AND v.group_id = p_group_id) r
      LEFT JOIN public.players p ON p.id = r.player_id;
  END IF;

  -- Same rows the /events list returns for (group, season) today — no row_type
  -- filter — so the pill matches the Rounds tab.
  SELECT count(*) INTO v_count FROM public.league_rounds
   WHERE group_id = p_group_id AND season_id = p_season_id;

  RETURN jsonb_build_object(
    'season_id',   p_season_id,
    'group_id',    p_group_id,
    'closed_at',   v_season.closed_at,
    'source',      CASE WHEN v_season.closed_at IS NOT NULL THEN 'final' ELSE 'live' END,
    'match_count', v_count,
    'standings',   v_rows,
    'as_of',       now()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_leaderboard_bootstrap(p_group_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_today     TEXT := current_date::text;
  v_me        JSONB;
  v_groups    JSONB;
  v_group_id  TEXT;
  v_seasons   JSONB;
  v_season_id TEXT;
  v_selected  JSONB;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'get_leaderboard_bootstrap: sign in required' USING ERRCODE = '42501';
  END IF;

  -- Caller identity: replaces am_i_super_admin + players + group_members in
  -- GroupContext. Player rows earliest-first, as GroupContext and
  -- getAuthorPlayerId() order them.
  WITH mine AS (
    SELECT id, display_name, email, is_heckler, created_at
      FROM public.players WHERE user_id = v_uid
  ), memberships AS (
    SELECT gm.group_id,
           min(gm.joined_at)          AS joined_at,   -- earliest per group, as GroupContext keeps
           bool_or(gm.role = 'admin') AS is_admin
      FROM public.group_members gm
     WHERE gm.player_id IN (SELECT id FROM mine) AND gm.is_active = 1
     GROUP BY gm.group_id
  )
  SELECT jsonb_build_object(
    'user_id',        v_uid,
    'player_ids',     COALESCE((SELECT jsonb_agg(id ORDER BY created_at) FROM mine), '[]'::jsonb),
    'display_name',   (SELECT display_name FROM mine ORDER BY created_at LIMIT 1),
    'email',          (SELECT email FROM mine ORDER BY created_at LIMIT 1),
    'is_heckler',     COALESCE((SELECT bool_or(is_heckler) FROM mine), false),
    'is_super_admin', public.am_i_super_admin(),
    'memberships',    COALESCE((SELECT jsonb_agg(jsonb_build_object(
                         'group_id', group_id, 'joined_at', joined_at, 'is_admin', is_admin)
                         ORDER BY joined_at DESC) FROM memberships), '[]'::jsonb)
  ) INTO v_me;

  -- All groups, leagues and rosters, as /groups returns today. The client splits
  -- by group_type (052).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', g.id, 'name', g.name, 'section_id', g.section_id, 'section_name', sec.name,
           'logo_url', g.logo_url, 'dollars_per_point', g.dollars_per_point,
           'group_type', g.group_type) ORDER BY g.name), '[]'::jsonb)
    INTO v_groups
    FROM public.groups g
    LEFT JOIN public.sections sec ON sec.id = g.section_id;

  -- Selected group: the requested league, else the most recently joined league,
  -- else the first league by name (GroupContext's resolution chain).
  SELECT g.id INTO v_group_id FROM public.groups g
   WHERE g.id = p_group_id AND g.group_type = 'league';
  IF v_group_id IS NULL THEN
    SELECT gm.group_id INTO v_group_id
      FROM public.group_members gm
      JOIN public.groups g ON g.id = gm.group_id
     WHERE gm.player_id IN (SELECT id FROM public.players WHERE user_id = v_uid)
       AND gm.is_active = 1 AND g.group_type = 'league'
     GROUP BY gm.group_id, g.name
     ORDER BY min(gm.joined_at) DESC, g.name
     LIMIT 1;
  END IF;
  IF v_group_id IS NULL THEN
    SELECT id INTO v_group_id FROM public.groups WHERE group_type = 'league' ORDER BY name LIMIT 1;
  END IF;

  IF v_group_id IS NOT NULL THEN
    -- Started seasons only, newest first (the filter listSeasons applies today).
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', s.id, 'group_id', s.group_id, 'start_date', s.start_date, 'end_date', s.end_date,
             'cup_champion_player_id', s.cup_champion_player_id,
             'cup_champion_notes', s.cup_champion_notes,
             'playoff_format', s.playoff_format, 'closed_at', s.closed_at)
             ORDER BY s.start_date DESC), '[]'::jsonb)
      INTO v_seasons
      FROM public.seasons s
     WHERE s.group_id = v_group_id AND s.start_date <= v_today;

    -- Selected season: the one in progress today, else the latest started.
    SELECT s.id INTO v_season_id FROM public.seasons s
     WHERE s.group_id = v_group_id AND s.start_date <= v_today
     ORDER BY (s.end_date >= v_today) DESC, s.start_date DESC
     LIMIT 1;

    IF v_season_id IS NOT NULL THEN
      v_selected := public.get_season_standings(v_group_id, v_season_id);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'me',                 v_me,
    'groups',             v_groups,
    'selected_group_id',  v_group_id,
    'seasons',            COALESCE(v_seasons, '[]'::jsonb),
    'selected_season_id', v_season_id,
    'selected_season',    v_selected,
    'as_of',              now()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.get_all_time_standings(p_group_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_today  TEXT := current_date::text;
  v_closed TEXT[];
  v_open   TEXT[];
  v_rows   JSONB;
BEGIN
  -- Started seasons only, matching the season list the All Time loop iterated.
  SELECT COALESCE(array_agg(id) FILTER (WHERE closed_at IS NOT NULL), '{}'),
         COALESCE(array_agg(id) FILTER (WHERE closed_at IS NULL), '{}')
    INTO v_closed, v_open
    FROM public.seasons
   WHERE group_id = p_group_id AND start_date <= v_today;

  WITH per_season AS (
    SELECT f.player_id, f.rounds_played, f.wins, f.losses, f.ties, f.total_points
      FROM public.season_standings_final f
     WHERE f.season_id = ANY (v_closed)
    UNION ALL
    SELECT v.player_id, v.rounds_played, v.wins, v.losses, v.ties, v.total_points
      FROM public.season_standings v
     WHERE v.season_id = ANY (v_open) AND v.group_id = p_group_id
  ), summed AS (
    SELECT player_id,
           sum(rounds_played)::bigint AS rounds_played,
           sum(wins)::bigint          AS wins,
           sum(losses)::bigint        AS losses,
           sum(ties)::bigint          AS ties,
           sum(total_points)          AS total_points,
           count(*)::int              AS seasons_played
      FROM per_season
     GROUP BY player_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'player_id', s.player_id, 'player_name', p.display_name, 'full_name', p.full_name,
           'rounds_played', s.rounds_played, 'wins', s.wins, 'losses', s.losses, 'ties', s.ties,
           'total_points', s.total_points, 'seasons_played', s.seasons_played, 'rank', s.rnk)
           ORDER BY s.rnk), '[]'::jsonb)
    INTO v_rows
    FROM (SELECT summed.*, row_number() OVER (ORDER BY total_points DESC, player_id) AS rnk
            FROM summed) s
    LEFT JOIN public.players p ON p.id = s.player_id;

  RETURN jsonb_build_object(
    'group_id',       p_group_id,
    'closed_seasons', to_jsonb(v_closed),
    'open_seasons',   to_jsonb(v_open),
    'standings',      v_rows,
    'as_of',          now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_season_standings(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_leaderboard_bootstrap(TEXT)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_all_time_standings(TEXT)     FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_season_standings(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_leaderboard_bootstrap(TEXT)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_all_time_standings(TEXT)     TO authenticated;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.get_leaderboard_bootstrap(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_season_standings(text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_all_time_standings(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '061: anon can execute a leaderboard read RPC';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_leaderboard_bootstrap(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_season_standings(text, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_all_time_standings(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '061: authenticated cannot execute a leaderboard read RPC';
  END IF;
END $$;
