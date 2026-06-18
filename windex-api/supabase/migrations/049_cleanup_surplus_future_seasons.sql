-- Migration 049: one-time purge of the surplus far-future seasons that the
-- season-rollover over-projection bug created.
--
-- Background: before migration 048, ensure_next_season_for_group() created one
-- future season per group per daily cron run (anchor marched forward off the
-- most-future end_date; the guard never blocked). By 2026-06-18 each group had
-- 40 future seasons out to 2065/2066. Migration 048 added a future-exists guard
-- that STOPPED the accrual; this migration is the matching ONE-TIME cleanup of
-- the rows already laid down.
--
-- Approved delete set (reviewed dry-run, 2026-06-18): keep each group's current
-- season plus the single earliest-future ("one ahead") season; delete the rest
-- of the contiguous future chain. That is 39 rows per group, 78 total — the
-- 2028…2066 chains for Windex Cup (keep sn_…_2027, 2026-12-01) and YC Windex
-- (keep sn_…_2027, 2026-09-01).
--
-- Safety: every deleted row is future-dated AND has no dependents
-- (championship_results / league_rounds / user_events) — the NOT EXISTS guards
-- make the DELETE provably non-destructive (dry-run confirmed cr_rows=0 and, as
-- future seasons, zero rounds/views). If any surplus row unexpectedly carries a
-- dependent it is SPARED by the guard, which would leave its group with >1
-- future season — caught by the post-cleanup assertion below, rolling the whole
-- migration back so we never half-clean. Runs in one transaction (db push).
--
-- The shipped UI filters (windex-admin CupChampions coming-season cutoff;
-- windex-expo listSeasons future filter) stay correct after this: they filtered
-- exactly these rows; now there is simply nothing left to filter.

-- =============================================================================
-- 1. Delete the surplus future seasons
-- =============================================================================
DELETE FROM public.seasons s
 WHERE s.start_date > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
   AND s.id <> (
     SELECT s2.id
       FROM public.seasons s2
      WHERE s2.group_id = s.group_id
        AND s2.start_date > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
      ORDER BY s2.start_date ASC
      LIMIT 1                                    -- keep the earliest future = one-ahead
   )
   AND NOT EXISTS (SELECT 1 FROM public.championship_results cr WHERE cr.season_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM public.league_rounds       lr WHERE lr.season_id = s.id)
   AND NOT EXISTS (SELECT 1 FROM public.user_events         ue WHERE ue.season_id = s.id);

-- =============================================================================
-- 2. Post-cleanup assertion — at most one future season per group
-- =============================================================================
--
-- If the delete under-converged (any group still has more than one
-- start_date > today season — e.g. a surplus row was spared by a NOT EXISTS
-- guard), abort so nothing commits.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT group_id, COUNT(*) AS future_count
      FROM public.seasons
     WHERE start_date > to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')
     GROUP BY group_id
    HAVING COUNT(*) > 1
  LOOP
    RAISE EXCEPTION
      'season cleanup under-converged: group % still has % future seasons',
      r.group_id, r.future_count;
  END LOOP;

  RAISE NOTICE 'season cleanup verified: every group has at most one future season';
END $$;
