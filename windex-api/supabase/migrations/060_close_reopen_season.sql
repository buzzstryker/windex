-- Migration 060: close_season() / reopen_season().
--
-- Each is a single statement from PostgREST, so it runs in ONE transaction:
-- any RAISE rolls back the snapshot and the closed_at change together.
--
-- The snapshot is read from the live season_standings view INSIDE the same
-- transaction. No rows are accepted from the caller. The view is
-- security_invoker (057); inside these SECURITY DEFINER functions it runs as the
-- owner (postgres), which bypasses RLS — identical to what authenticated sees,
-- because every base-table SELECT policy is USING (true).
--
-- Close guards (all hard-fail):
--   * season exists and is not already closed
--   * season has ended (end_date < today, compared as TEXT 'YYYY-MM-DD' like
--     every other reader). 039 keeps zero-round roster rows for seasons that
--     have not ended, so freezing one early would freeze those rows.
--   * a finishing order is recorded: at least one championship_results row with
--     place set. Award-only rows (FJ Socks, place NULL, 046) do not count.
--   * no leftover snapshot rows, live standings non-empty, snapshot == live
--
-- _close_season_core holds the guards so the 062 backfill (which runs with no
-- JWT, so am_i_super_admin() is false) goes through exactly the same checks.
-- It is not executable by any client role.
--
-- closed_at is guarded by the 058 trigger; these functions open it with the
-- transaction-local windex.season_closure setting and close it again.

CREATE OR REPLACE FUNCTION public._close_season_core(p_season_id TEXT, p_actor UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_season public.seasons%ROWTYPE;
  v_rows   INT;
  v_diff   INT;
  v_now    TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO v_season FROM public.seasons WHERE id = p_season_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'close_season: season % not found', p_season_id USING ERRCODE = 'P0002';
  END IF;
  IF v_season.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'close_season: season % is already closed (closed_at %)',
      p_season_id, v_season.closed_at USING ERRCODE = '55000';
  END IF;
  IF v_season.end_date >= current_date::text THEN
    RAISE EXCEPTION 'close_season: season % has not ended (end_date %)',
      p_season_id, v_season.end_date USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.championship_results
                  WHERE season_id = p_season_id AND place IS NOT NULL) THEN
    RAISE EXCEPTION 'close_season: season % has no finishing order (no championship_results row with a place); record it first',
      p_season_id USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.season_standings_final WHERE season_id = p_season_id) THEN
    RAISE EXCEPTION 'close_season: season % is open but already has snapshot rows; inspect before closing',
      p_season_id USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.season_standings_final
    (season_id, group_id, player_id, rounds_played, total_points, wins, losses, ties, snapshot_at, snapshot_by)
  SELECT ss.season_id, ss.group_id, ss.player_id, ss.rounds_played, ss.total_points,
         ss.wins, ss.losses, ss.ties, v_now, p_actor
    FROM public.season_standings ss
   WHERE ss.season_id = p_season_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'close_season: live standings for season % are empty; nothing to freeze',
      p_season_id USING ERRCODE = '55000';
  END IF;

  -- Snapshot must equal live, both directions, in this transaction.
  SELECT count(*) INTO v_diff FROM (
    (SELECT season_id, group_id, player_id, rounds_played, total_points, wins, losses, ties
       FROM public.season_standings WHERE season_id = p_season_id
     EXCEPT ALL
     SELECT season_id, group_id, player_id, rounds_played, total_points, wins, losses, ties
       FROM public.season_standings_final WHERE season_id = p_season_id)
    UNION ALL
    (SELECT season_id, group_id, player_id, rounds_played, total_points, wins, losses, ties
       FROM public.season_standings_final WHERE season_id = p_season_id
     EXCEPT ALL
     SELECT season_id, group_id, player_id, rounds_played, total_points, wins, losses, ties
       FROM public.season_standings WHERE season_id = p_season_id)
  ) d;
  IF v_diff <> 0 THEN
    RAISE EXCEPTION 'close_season: snapshot for season % differs from live in % row(s)',
      p_season_id, v_diff USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('windex.season_closure', 'on', true);
  UPDATE public.seasons SET closed_at = v_now, updated_at = v_now WHERE id = p_season_id;
  PERFORM set_config('windex.season_closure', '', true);

  RETURN jsonb_build_object('season_id', p_season_id, 'closed_at', v_now, 'snapshot_rows', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public._close_season_core(TEXT, UUID) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.close_season(p_season_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.am_i_super_admin() THEN
    RAISE EXCEPTION 'not authorized: close_season requires super admin' USING ERRCODE = '42501';
  END IF;
  RETURN public._close_season_core(p_season_id, auth.uid());
END;
$$;

CREATE OR REPLACE FUNCTION public.reopen_season(p_season_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_season public.seasons%ROWTYPE;
  v_rows   INT;
BEGIN
  IF NOT public.am_i_super_admin() THEN
    RAISE EXCEPTION 'not authorized: reopen_season requires super admin' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_season FROM public.seasons WHERE id = p_season_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reopen_season: season % not found', p_season_id USING ERRCODE = 'P0002';
  END IF;
  IF v_season.closed_at IS NULL THEN
    RAISE EXCEPTION 'reopen_season: season % is not closed', p_season_id USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.season_standings_final WHERE season_id = p_season_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'reopen_season: season % is closed but has no snapshot rows; inspect before reopening',
      p_season_id USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('windex.season_closure', 'on', true);
  UPDATE public.seasons SET closed_at = NULL, updated_at = now() WHERE id = p_season_id;
  PERFORM set_config('windex.season_closure', '', true);

  RETURN jsonb_build_object('season_id', p_season_id, 'reopened_at', now(), 'snapshot_rows_deleted', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.close_season(TEXT)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reopen_season(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_season(TEXT)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_season(TEXT) TO authenticated;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.close_season(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.reopen_season(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._close_season_core(text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._close_season_core(text, uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._close_season_core(text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '060: a closure function is executable by the wrong role';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.close_season(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.reopen_season(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '060: authenticated cannot execute close_season / reopen_season';
  END IF;
END $$;
