-- Migration 050: Cup scores (gross / net / free pops / net-net) + points-race
-- pops helper + playoff_format flag. Phase A of the cup finishing-order
-- extension. All four parts are additive and back-compatible — no existing row
-- is rewritten and the current admin save path keeps working byte-for-byte.
--
-- Parts:
--   1. championship_results gains gross_score, net_score, free_pops, net_net.
--      net_net is a GENERATED STORED column (net_score - free_pops) so it can
--      never desync from its inputs. Existing 2020-2025 rows survive untouched:
--      gross/net/net_net = NULL, free_pops = 0, place + is_last_place unchanged.
--   2. get_season_points_pops(season) — single source of truth for the
--      points-race award. Ranks raw season totals with NO roster filter so
--      retired/departed players (e.g. Getty in 2020) rank correctly; returns
--      the top 4 with pops 2.0 / 1.5 / 1.0 / 0.5.
--   3. replace_finishing_order — CREATE OR REPLACE. Same signature, same
--      am_i_super_admin() gate, same atomic DELETE-then-INSERT. Now accepts
--      optional gross_score / net_score per row and injects free_pops from the
--      helper (scored rows only). place stays CALLER-SUPPLIED — the UI confirms
--      the order (including playoff results); the RPC does not rank. free_pops
--      is never accepted from the client.
--   4. seasons.playoff_format flag — UI-only discriminator for Phase B
--      (straight net-net order vs qualifiers + playoff entry). Set true for the
--      two playoff-era Windex Cup seasons (2024, 2025); affects nothing in the
--      RPC or any ranking.
--
-- Whole migration runs in one transaction; any verification failure at the end
-- rolls everything back (matches the 025 / 032 / 047 pattern).

-- =============================================================================
-- 1. championship_results: gross / net / free_pops / net_net
-- =============================================================================
ALTER TABLE public.championship_results
  ADD COLUMN IF NOT EXISTS gross_score NUMERIC(5,1),                    -- entered; NULL = unknown (historical)
  ADD COLUMN IF NOT EXISTS net_score   NUMERIC(5,1),                    -- entered, NOT computed; NULL = unknown
  ADD COLUMN IF NOT EXISTS free_pops   NUMERIC(3,1) NOT NULL DEFAULT 0; -- points-race award magnitude (positive)

-- net_net is the ranking key, derived once in the DB and impossible to desync.
-- Added separately so the IF NOT EXISTS guards above don't interfere with the
-- GENERATED clause on re-run.
ALTER TABLE public.championship_results
  ADD COLUMN IF NOT EXISTS net_net NUMERIC(6,1)
    GENERATED ALWAYS AS (net_score - free_pops) STORED;

COMMENT ON COLUMN public.championship_results.gross_score IS
  'Cup gross score, entered by an admin. NULL on historical rows where the gross is unknown.';
COMMENT ON COLUMN public.championship_results.net_score IS
  'Cup net score, ENTERED (not computed from a handicap). NULL on historical rows where the net is unknown.';
COMMENT ON COLUMN public.championship_results.free_pops IS
  'Points-race award magnitude (positive): top-4 season points finishers get 2.0/1.5/1.0/0.5. Server-set from get_season_points_pops on scored rows; 0 otherwise. Never client-supplied.';
COMMENT ON COLUMN public.championship_results.net_net IS
  'GENERATED net_score - free_pops. The cup ranking key. NULL when net_score is NULL (unscored/historical rows).';

-- =============================================================================
-- 2. get_season_points_pops(season) — points-race top-4, retired-inclusive
-- =============================================================================
--
-- Ranks players by raw season points total straight off league_scores ⨝
-- league_rounds (SUM of override-priority score), with NO group_members /
-- is_active / retired_at / current_date filter. This is deliberately NOT
-- season_standings: that view drops retired members and zero-round members of
-- completed seasons (migrations 030/039), which would silently exclude a real
-- points finisher (e.g. Getty, retired, finished 3rd in 2020). season_aggregate
-- rows for 2020-2022 are included, which is correct — they ARE the points race
-- for those years.
--
-- DESC = most points = rank 1 (matches total_points / season_standings
-- ordering — not inverted). RANK() so a tie shares a place (standard
-- competition ranking, consistent with the rest of the cup); a tie at the top
-- therefore shares the higher pop and skips the next slot. Real data has no
-- ties at these magnitudes.
--
-- SECURITY DEFINER to bypass RLS so retired players are visible. Reading season
-- point totals is not sensitive (standings are browse-all to authenticated),
-- but we still restrict EXECUTE to authenticated per the 047 definer-fn
-- convention. Used by replace_finishing_order below and, in Phase B, by the
-- admin UI preview — one source of truth for pops.
CREATE OR REPLACE FUNCTION public.get_season_points_pops(p_season_id TEXT)
RETURNS TABLE(player_id TEXT, free_pops NUMERIC)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    ranked.player_id,
    (CASE ranked.rnk
       WHEN 1 THEN 2.0
       WHEN 2 THEN 1.5
       WHEN 3 THEN 1.0
       WHEN 4 THEN 0.5
     END)::NUMERIC AS free_pops
  FROM (
    SELECT
      totals.player_id,
      RANK() OVER (ORDER BY totals.pts DESC) AS rnk
    FROM (
      SELECT
        ls.player_id,
        SUM(COALESCE(ls.score_override, ls.score_value)) AS pts
      FROM public.league_rounds lr
      JOIN public.league_scores ls ON ls.league_round_id = lr.id
      WHERE lr.season_id = p_season_id
      GROUP BY ls.player_id
    ) totals
  ) ranked
  WHERE ranked.rnk <= 4;
$$;

COMMENT ON FUNCTION public.get_season_points_pops(TEXT) IS
  'Top-4 season points finishers and their free-pops award (2.0/1.5/1.0/0.5). Raw totals from league_scores ⨝ league_rounds, NO roster/retired filter — retired and departed players rank. Single source of truth for cup free pops.';

REVOKE ALL ON FUNCTION public.get_season_points_pops(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_season_points_pops(TEXT) TO authenticated;

-- =============================================================================
-- 3. replace_finishing_order — accept scores, inject pops, keep place caller-set
-- =============================================================================
--
-- Unchanged: signature, SECURITY DEFINER, am_i_super_admin() gate, atomic
-- DELETE-then-INSERT (one function body = one transaction). The per-row
-- triggers (group-match, membership, cup-champion sync) fire exactly as before.
--
-- Changed: p_rows may now carry optional gross_score / net_score. The recordset
-- gains those two columns; jsonb_to_recordset sets any missing key to NULL, so
-- old payloads { player_id, place, is_last_place } stay fully valid. free_pops
-- is NOT read from p_rows — it is injected from get_season_points_pops via a
-- LEFT JOIN, and ONLY for scored rows:
--   net_score IS NOT NULL  -> COALESCE(pop.free_pops, 0)   (0 if not top-4)
--   net_score IS NULL      -> 0                            (manual/historical)
-- so the manual/unscored path is byte-identical to today. net_net is GENERATED
-- and intentionally absent from the INSERT column list (writing it would error).
-- place is taken straight from the recordset — the RPC does NOT rank.
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

  -- 2. Insert the new rows. gross/net come from the payload; free_pops is
  --    server-derived (scored rows only); place/is_last_place are caller-set.
  --    net_net is GENERATED and must not appear in the column list.
  INSERT INTO public.championship_results
    (season_id, group_id, player_id, gross_score, net_score, free_pops, place, is_last_place)
  SELECT
    p_season_id,
    p_group_id,
    r.player_id,
    r.gross_score,
    r.net_score,
    CASE WHEN r.net_score IS NOT NULL THEN COALESCE(pop.free_pops, 0) ELSE 0 END,
    r.place,
    COALESCE(r.is_last_place, false)
  FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb))
    AS r(player_id TEXT, gross_score NUMERIC, net_score NUMERIC, place INT, is_last_place BOOLEAN)
  LEFT JOIN public.get_season_points_pops(p_season_id) AS pop
    ON pop.player_id = r.player_id;
END;
$$;

COMMENT ON FUNCTION public.replace_finishing_order(TEXT, TEXT, JSONB) IS
  'Atomically replace a season''s full finishing order (DELETE + INSERT in one transaction). Super-admin gated. p_rows = JSON array of { player_id, place, is_last_place, gross_score?, net_score? }; free_pops is server-derived from get_season_points_pops (scored rows only) and never client-supplied; net_net is GENERATED. place is caller-supplied (the RPC does not rank). Empty array clears the season.';

-- EXECUTE grant is unchanged from migration 047 (REVOKE PUBLIC / GRANT
-- authenticated already in place); CREATE OR REPLACE preserves it.

-- =============================================================================
-- 4. seasons.playoff_format — Phase B UI discriminator
-- =============================================================================
ALTER TABLE public.seasons
  ADD COLUMN IF NOT EXISTS playoff_format BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.seasons.playoff_format IS
  'TRUE for playoff-era cup seasons (qualifiers + playoff entry for the top of the board); FALSE for straight net-net order. UI-only flag — does not affect replace_finishing_order or any ranking.';

-- The two playoff-era Windex Cup seasons:
--   iFDXNJN8Tc2a4tii7kZxQg  = 2023-12-01 .. 2024-11-30  (2024)
--   W8etdIH-RvC7TcJQz8k-hQ  = 2024-12-01 .. 2025-11-30  (2025)
UPDATE public.seasons
   SET playoff_format = true,
       updated_at = now()
 WHERE id IN ('iFDXNJN8Tc2a4tii7kZxQg', 'W8etdIH-RvC7TcJQz8k-hQ');

-- =============================================================================
-- 5. Verification — abort (and roll back the whole migration) on any mismatch
-- =============================================================================
DO $$
DECLARE
  v_cols     INT;
  v_dirty    INT;
  v_true     INT;
  v_true_ok  INT;
BEGIN
  -- 5a. All four new columns landed on championship_results.
  SELECT count(*) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'championship_results'
     AND column_name IN ('gross_score', 'net_score', 'free_pops', 'net_net');
  IF v_cols <> 4 THEN
    RAISE EXCEPTION 'championship_results: expected 4 new columns, found %', v_cols;
  END IF;

  -- 5b. Non-destructive: every PRE-EXISTING row is now free_pops = 0 and
  --     net_net = NULL (none have a net_score yet). Any other state means the
  --     add somehow rewrote data.
  SELECT count(*) INTO v_dirty
    FROM public.championship_results
   WHERE free_pops <> 0 OR net_net IS NOT NULL OR gross_score IS NOT NULL OR net_score IS NOT NULL;
  IF v_dirty <> 0 THEN
    RAISE EXCEPTION 'championship_results: % existing rows unexpectedly carry score data after add', v_dirty;
  END IF;

  -- 5c. playoff_format true for exactly the two target seasons, both Windex Cup.
  SELECT count(*) INTO v_true
    FROM public.seasons WHERE playoff_format;
  SELECT count(*) INTO v_true_ok
    FROM public.seasons s
    JOIN public.groups g ON g.id = s.group_id
   WHERE s.playoff_format
     AND g.name = 'Windex Cup'
     AND s.id IN ('iFDXNJN8Tc2a4tii7kZxQg', 'W8etdIH-RvC7TcJQz8k-hQ');
  IF v_true <> 2 OR v_true_ok <> 2 THEN
    RAISE EXCEPTION 'playoff_format: expected exactly 2 true rows (both Windex Cup 2024/2025); total true=%, matched=%', v_true, v_true_ok;
  END IF;

  RAISE NOTICE 'migration 050 ok: 4 cup-score columns added (non-destructive), pops helper created, replace_finishing_order extended, playoff_format set on 2 seasons';
END $$;
