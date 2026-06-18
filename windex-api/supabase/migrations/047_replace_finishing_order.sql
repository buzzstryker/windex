-- Migration 047: transactional replace of a season's full finishing order.
--
-- Problem this fixes: windex-admin replaced the finishing order with a
-- client-side DELETE-then-INSERT (two separate PostgREST calls, see
-- windex-admin/src/api/championshipResults.ts before this change). The two
-- calls are not in one transaction, so if the INSERT failed — JWT expiry in
-- the gap, or one of the per-row triggers (group-match / membership)
-- rejecting a row — the DELETE had already committed and the season was left
-- WIPED with nothing re-inserted. The reported failure ("Failed to clear
-- existing results: JWT expired") was the milder case where the DELETE itself
-- 401'd and nothing was lost; this function removes the data-loss window
-- entirely.
--
-- Design: a single SECURITY DEFINER function does DELETE + INSERT in one
-- function body = one implicit transaction. Either the whole replace commits
-- or nothing changes. The existing per-row triggers from migrations 032/046
-- (group-match, membership enforcement, cup-champion sync) fire exactly as
-- before — a trigger RAISE inside the INSERT aborts the whole function, so
-- the DELETE rolls back with it. That is the atomicity guarantee.
--
-- Auth: gated with am_i_super_admin() (migration 014), mirroring the RLS
-- policies on championship_results (migration 032 §5). am_i_super_admin() is
-- itself SECURITY DEFINER and reads auth.uid() from the request JWT GUC, so
-- it resolves the *caller's* identity correctly even though this function
-- runs the body as the definer. GRANT EXECUTE to authenticated; the
-- am_i_super_admin() gate is the real guard (matching the create-group
-- edge function's handler-side gate pattern).
--
-- Row shape: p_rows is a JSON array of objects carrying only
-- { player_id, place, is_last_place }. season_id and group_id come from the
-- p_season_id / p_group_id parameters and are applied to every inserted row —
-- a single source of truth, so a row can never disagree with the season it's
-- being written under. (This intentionally differs from carrying season_id /
-- group_id per row: redundant per-row keys would just be an opportunity to
-- desync.) place is nullable and is_last_place defaults false to match the
-- migration-046 shape (place=NULL + is_last_place=true is a valid award-only
-- row; the championship_results_place_or_award CHECK still enforces
-- place-or-award). Empty array => delete-only (atomic clear of the season).

CREATE OR REPLACE FUNCTION public.replace_finishing_order(
  p_season_id TEXT,
  p_group_id  TEXT,
  p_rows      JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Super-admin gate (mirrors championship_results RLS, migration 032).
  IF NOT public.am_i_super_admin() THEN
    RAISE EXCEPTION 'not authorized: replace_finishing_order requires super admin'
      USING ERRCODE = '42501';  -- insufficient_privilege -> PostgREST 403
  END IF;

  -- 1. Clear the season's existing finishing order.
  DELETE FROM public.championship_results
   WHERE season_id = p_season_id;

  -- 2. Insert the new rows (skipped naturally when p_rows is empty/null).
  --    Per-row triggers (group-match, membership, cup-champion sync) fire
  --    here; any RAISE aborts the whole function and rolls back the DELETE.
  INSERT INTO public.championship_results
    (season_id, group_id, player_id, place, is_last_place)
  SELECT
    p_season_id,
    p_group_id,
    r.player_id,
    r.place,
    COALESCE(r.is_last_place, false)
  FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb))
    AS r(player_id TEXT, place INT, is_last_place BOOLEAN);
END;
$$;

COMMENT ON FUNCTION public.replace_finishing_order(TEXT, TEXT, JSONB) IS
  'Atomically replace a season''s full finishing order (DELETE + INSERT in one transaction). Super-admin gated via am_i_super_admin(). p_rows = JSON array of { player_id, place, is_last_place }; season_id/group_id come from the params. Empty array clears the season. Replaces the former non-atomic client-side DELETE-then-INSERT in windex-admin.';

-- The am_i_super_admin() gate inside the body is the real guard; restrict the
-- callable surface to authenticated sessions anyway.
REVOKE ALL ON FUNCTION public.replace_finishing_order(TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_finishing_order(TEXT, TEXT, JSONB) TO authenticated;
