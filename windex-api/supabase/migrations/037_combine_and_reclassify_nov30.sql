-- Migration 037: combine two 2025-11-30 ledger rows into one tournament,
-- and reclassify one Nov 30 row as a regular round.
--
-- Fix 1: external_event_id 'k25VhYNpQbCy.5956-3GGA' (buy-in: everyone -200,
-- 8 players) and 'RrCesItkfmPAHpXlIovh' (payouts: Colm 850, X 300, Dr. 150,
-- Buzz 100, BK/ATrain/FJ/Cal 50 each, 8 players) are two halves of one
-- tournament. They settle to zero together (1600 in / 1600 out). Combining
-- into one row on RrCesItkfmPAHpXlIovh with netted score_values (payout
-- minus 200 per player) and tournament metadata; the buy-in row and its
-- scores are deleted.
--
-- Fix 2: external_event_id 'Ni2IaViqTlIIyZEDgQpY' (Buzz +75, FJ +75, BK/X/Dr.
-- -7, Colm -64, ATrain -65, 7 players, settles to zero) is a regular
-- head-to-head round mis-flagged as signature. Flag fix only, no score change.

-- ===== Fix 1: combine the buy-in and payout rows =====

-- Step 1a: update the surviving row's metadata to tournament shape.
UPDATE public.league_rounds
   SET row_type = 'regular_round',
       is_signature_event = 0,
       is_tournament = 1,
       tournament_buyin = 200
 WHERE external_event_id = 'RrCesItkfmPAHpXlIovh'
   AND round_date = '2025-11-30';

-- Step 1b: overwrite the surviving row's league_scores with netted values.
-- Done per-player to be explicit about each value; using subselect for
-- the league_round_id and player_id lookups.
UPDATE public.league_scores ls
   SET score_value = CASE p.display_name
     WHEN 'Colm'   THEN 650
     WHEN 'X'      THEN 100
     WHEN 'Dr.'    THEN -50
     WHEN 'Buzz'   THEN -100
     WHEN 'BK'     THEN -150
     WHEN 'ATrain' THEN -150
     WHEN 'FJ'     THEN -150
     WHEN 'Cal'    THEN -150
   END
  FROM public.players p,
       public.league_rounds lr
 WHERE ls.player_id = p.id
   AND ls.league_round_id = lr.id
   AND lr.external_event_id = 'RrCesItkfmPAHpXlIovh'
   AND lr.round_date = '2025-11-30'
   AND p.display_name IN ('Colm','X','Dr.','Buzz','BK','ATrain','FJ','Cal');

-- Step 1c: delete the buy-in row's league_scores, then the row itself.
DELETE FROM public.league_scores
 WHERE league_round_id IN (
   SELECT id FROM public.league_rounds
    WHERE external_event_id = 'k25VhYNpQbCy.5956-3GGA'
      AND round_date = '2025-11-30'
 );

DELETE FROM public.league_rounds
 WHERE external_event_id = 'k25VhYNpQbCy.5956-3GGA'
   AND round_date = '2025-11-30';

-- ===== Fix 2: reclassify the regular round =====

UPDATE public.league_rounds
   SET row_type = 'regular_round',
       is_signature_event = 0
 WHERE external_event_id = 'Ni2IaViqTlIIyZEDgQpY'
   AND round_date = '2025-11-30';

-- ===== Verification =====

DO $$
DECLARE
  v_combined_count INT;
  v_combined_sum NUMERIC;
  v_buyin_gone INT;
  v_regular_fixed INT;
BEGIN
  -- Combined tournament: 1 row, 8 scores, sum to zero.
  SELECT count(*) INTO v_combined_count FROM public.league_rounds
   WHERE external_event_id = 'RrCesItkfmPAHpXlIovh'
     AND is_tournament = 1 AND tournament_buyin = 200
     AND row_type = 'regular_round' AND is_signature_event = 0;

  SELECT sum(ls.score_value) INTO v_combined_sum
    FROM public.league_scores ls
    JOIN public.league_rounds lr ON lr.id = ls.league_round_id
   WHERE lr.external_event_id = 'RrCesItkfmPAHpXlIovh';

  -- Buy-in row should be gone.
  SELECT count(*) INTO v_buyin_gone FROM public.league_rounds
   WHERE external_event_id = 'k25VhYNpQbCy.5956-3GGA';

  -- Regular round reclassification.
  SELECT count(*) INTO v_regular_fixed FROM public.league_rounds
   WHERE external_event_id = 'Ni2IaViqTlIIyZEDgQpY'
     AND row_type = 'regular_round' AND is_signature_event = 0;

  RAISE NOTICE 'Combined tournament rows: % (expected 1)', v_combined_count;
  RAISE NOTICE 'Combined tournament sum: % (expected 0)', v_combined_sum;
  RAISE NOTICE 'Buy-in row remaining: % (expected 0)', v_buyin_gone;
  RAISE NOTICE 'Regular round reclassified: % (expected 1)', v_regular_fixed;
END $$;
