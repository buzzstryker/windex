-- Migration 038: combine the final 2025-11-30 buy-in/payout pair into one tournament.
--
-- external_event_id 'CZqosMSsxJkAaG4dpC3X' (8 players each at -90, sum -720) and
-- 'Jw7jdECZ34IAI4yyDamb' (6 players: BK/FJ/ATrain/Dr. +160, Cal/X +40, sum +720)
-- are two halves of one $90-buyin tournament with 8 entrants. Buzz and Colm
-- paid in but did not place. Combining onto Jw7jdEC with netted score_values
-- (payout minus 90 per player) and tournament metadata; the buy-in row and its
-- scores are deleted. Buzz and Colm gain new league_scores rows at -90.

-- ===== Step 1: update surviving row metadata =====

UPDATE public.league_rounds
   SET row_type = 'regular_round',
       is_signature_event = 0,
       is_tournament = 1,
       tournament_buyin = 90
 WHERE external_event_id = 'Jw7jdECZ34IAI4yyDamb'
   AND round_date = '2025-11-30';

-- ===== Step 2: overwrite existing 6 payout scores with netted values =====

UPDATE public.league_scores ls
   SET score_value = CASE p.display_name
     WHEN 'BK'     THEN 70
     WHEN 'FJ'     THEN 70
     WHEN 'ATrain' THEN 70
     WHEN 'Dr.'    THEN 70
     WHEN 'Cal'    THEN -50
     WHEN 'X'      THEN -50
   END
  FROM public.players p,
       public.league_rounds lr
 WHERE ls.player_id = p.id
   AND ls.league_round_id = lr.id
   AND lr.external_event_id = 'Jw7jdECZ34IAI4yyDamb'
   AND lr.round_date = '2025-11-30'
   AND p.display_name IN ('BK','FJ','ATrain','Dr.','Cal','X');

-- ===== Step 3: insert Buzz and Colm scores onto the surviving round =====
-- They paid -90 each but had no payout row, so they need new league_scores
-- entries on Jw7jdEC. Mirror the schema of the existing scores there
-- (id, league_round_id, player_id, score_value, score_override null,
--  created_at/updated_at default).
-- IMPORTANT: derive the league_round_id and player_id via subselects so the
-- migration is portable across environments.

INSERT INTO public.league_scores (id, league_round_id, player_id, score_value)
SELECT
  gen_random_uuid()::text,
  lr.id,
  p.id,
  CASE p.display_name
    WHEN 'Buzz' THEN -90
    WHEN 'Colm' THEN -90
  END
FROM public.league_rounds lr
CROSS JOIN public.players p
WHERE lr.external_event_id = 'Jw7jdECZ34IAI4yyDamb'
  AND lr.round_date = '2025-11-30'
  AND p.display_name IN ('Buzz', 'Colm');

-- ===== Step 4: delete the buy-in row and its scores =====

DELETE FROM public.league_scores
 WHERE league_round_id IN (
   SELECT id FROM public.league_rounds
    WHERE external_event_id = 'CZqosMSsxJkAaG4dpC3X'
      AND round_date = '2025-11-30'
 );

DELETE FROM public.league_rounds
 WHERE external_event_id = 'CZqosMSsxJkAaG4dpC3X'
   AND round_date = '2025-11-30';

-- ===== Verification =====

DO $$
DECLARE
  v_combined_count INT;
  v_score_count INT;
  v_combined_sum NUMERIC;
  v_buyin_gone INT;
  v_remaining_sig INT;
BEGIN
  SELECT count(*) INTO v_combined_count FROM public.league_rounds
   WHERE external_event_id = 'Jw7jdECZ34IAI4yyDamb'
     AND is_tournament = 1 AND tournament_buyin = 90
     AND row_type = 'regular_round' AND is_signature_event = 0;

  SELECT count(*) INTO v_score_count FROM public.league_scores ls
    JOIN public.league_rounds lr ON lr.id = ls.league_round_id
   WHERE lr.external_event_id = 'Jw7jdECZ34IAI4yyDamb';

  SELECT sum(ls.score_value) INTO v_combined_sum FROM public.league_scores ls
    JOIN public.league_rounds lr ON lr.id = ls.league_round_id
   WHERE lr.external_event_id = 'Jw7jdECZ34IAI4yyDamb';

  SELECT count(*) INTO v_buyin_gone FROM public.league_rounds
   WHERE external_event_id = 'CZqosMSsxJkAaG4dpC3X';

  SELECT count(*) INTO v_remaining_sig FROM public.league_rounds
   WHERE row_type = 'signature_round' AND round_date = '2025-11-30';

  RAISE NOTICE 'Combined tournament rows: % (expected 1)', v_combined_count;
  RAISE NOTICE 'Combined score rows: % (expected 8)', v_score_count;
  RAISE NOTICE 'Combined tournament sum: % (expected 0)', v_combined_sum;
  RAISE NOTICE 'Buy-in row remaining: % (expected 0)', v_buyin_gone;
  RAISE NOTICE 'Remaining 2025-11-30 signature_rounds: % (expected 0)', v_remaining_sig;
END $$;
