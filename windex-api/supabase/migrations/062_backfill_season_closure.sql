-- Migration 062: close + snapshot the past seasons that have a recorded champion.
--
-- Candidates: seasons whose end_date has passed and are still open. A candidate
-- is closed only if cup_champion_player_id is set AND it has a finishing order
-- (a championship_results row with place set — award-only FJ Socks rows, place
-- NULL, do not count; same rule as _close_season_core in 060). Every other past
-- season is listed in a NOTICE for Buzz and left open — never force-closed.
-- _close_season_core then re-applies every guard (ended, finishing order,
-- non-empty live standings, snapshot == live) and raises on any failure.
--
-- v_expected = 6, confirmed by Buzz's dry run (2026-10-19): the Windex Cup
-- seasons 2019-20 through 2024-25 in group 4kKh0sk1QpSvjPE6p8VNKA. If
-- production closes a different number, the whole migration rolls back.
--
-- Expected FLAG notices, left open on purpose:
--   NhQ38YGqQNhvBjWqzCqb          (group a-f-NDMUNTtGA6JxDT8S9CQ) no champion /
--                                 finishing order; 10 live standings rows
--   sn_SFrbUMKGvbqmCBTVHjHc_2026  (group SFrbUMKGvbqmCBTVHjHc) 0 standings rows
-- Closing seasons for groups without a championship is a BACKLOG item.
--
-- Runs as the migration role with no JWT, so snapshot_by is NULL.

DO $$
DECLARE
  r          RECORD;
  v_closed   INT := 0;
  v_flagged  INT := 0;
  v_diff     INT;
  v_expected CONSTANT INT := 6;  -- confirmed by the 2026-10-19 dry run
BEGIN
  FOR r IN
    SELECT s.id, s.group_id, s.start_date, s.end_date, s.cup_champion_player_id,
           EXISTS (SELECT 1 FROM public.championship_results cr
                    WHERE cr.season_id = s.id AND cr.place IS NOT NULL) AS has_order
      FROM public.seasons s
     WHERE s.end_date < current_date::text
       AND s.closed_at IS NULL
     ORDER BY s.group_id, s.start_date
  LOOP
    IF r.cup_champion_player_id IS NOT NULL AND r.has_order THEN
      PERFORM public._close_season_core(r.id, NULL);
      v_closed := v_closed + 1;
      RAISE NOTICE '062 closed: season % (group %, % .. %)', r.id, r.group_id, r.start_date, r.end_date;
    ELSE
      v_flagged := v_flagged + 1;
      RAISE NOTICE '062 FLAG for Buzz, left open: season % (group %, % .. %) champion=% finishing_order=%',
        r.id, r.group_id, r.start_date, r.end_date,
        COALESCE(r.cup_champion_player_id, 'none'), CASE WHEN r.has_order THEN 'yes' ELSE 'NONE' END;
    END IF;
  END LOOP;

  IF v_closed <> v_expected THEN
    RAISE EXCEPTION '062: expected % seasons closed, got % (flagged %); review NOTICEs, nothing applied',
      v_expected, v_closed, v_flagged;
  END IF;

  -- Snapshot == live for every closed season (also checked per season in the core).
  SELECT count(*) INTO v_diff FROM (
    (SELECT season_id, group_id, player_id, rounds_played, total_points, wins, losses, ties
       FROM public.season_standings
      WHERE season_id IN (SELECT id FROM public.seasons WHERE closed_at IS NOT NULL)
     EXCEPT ALL
     SELECT season_id, group_id, player_id, rounds_played, total_points, wins, losses, ties
       FROM public.season_standings_final)
    UNION ALL
    (SELECT season_id, group_id, player_id, rounds_played, total_points, wins, losses, ties
       FROM public.season_standings_final
     EXCEPT ALL
     SELECT season_id, group_id, player_id, rounds_played, total_points, wins, losses, ties
       FROM public.season_standings
      WHERE season_id IN (SELECT id FROM public.seasons WHERE closed_at IS NOT NULL))
  ) d;
  IF v_diff <> 0 THEN
    RAISE EXCEPTION '062: snapshot differs from live in % row(s)', v_diff;
  END IF;

  IF EXISTS (SELECT 1 FROM public.seasons
              WHERE closed_at IS NOT NULL AND end_date >= current_date::text) THEN
    RAISE EXCEPTION '062: an unfinished season was closed';
  END IF;

  RAISE NOTICE '062 done: % closed, % flagged', v_closed, v_flagged;
END $$;
