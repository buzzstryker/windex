-- Migration 036: fix the metadata flags on one 2025-11-30 round.
--
-- The row with external_event_id = 'rpjTsRFRNbrtS6EbYh5O' is a single-winner
-- pot tournament (FJ +700, seven others -100 each, 8 players, settles to zero).
-- The per-player score_values are already correctly netted (winnings minus
-- buy-in). Only the metadata flags need correcting, to match the May 17, 2026
-- tournament shape (round_id 8275f8f4): one league_rounds row per tournament
-- with is_tournament = 1, tournament_buyin populated, row_type = 'regular_round',
-- and is_signature_event = 0.
--
--   - is_tournament:      0    -> 1
--   - tournament_buyin:   null -> 100
--   - row_type:           'signature_round' -> 'regular_round'
--   - is_signature_event: 1    -> 0
--
-- Context: migration 035 (already applied) set this row to 'signature_round' as
-- one of the six 2025-11-30 cup-day rounds. 035 reclassified ONLY pre-2023 rows
-- to 'season_aggregate'; it did not touch the Nov-30 rows beyond the
-- signature_round label, so there is no season_aggregate conflict for this row.
--
-- First of Buzz's per-row Nov 30 corrections; the other Nov 30 rows are being
-- classified individually as flag-fix-in-place vs full re-entry.

UPDATE public.league_rounds
   SET is_tournament = 1,
       tournament_buyin = 100,
       row_type = 'regular_round',
       is_signature_event = 0
 WHERE external_event_id = 'rpjTsRFRNbrtS6EbYh5O'
   AND round_date = '2025-11-30';

DO $$
DECLARE v_count INT;
BEGIN
  SELECT count(*) INTO v_count FROM public.league_rounds
    WHERE external_event_id = 'rpjTsRFRNbrtS6EbYh5O'
      AND is_tournament = 1
      AND tournament_buyin = 100
      AND row_type = 'regular_round'
      AND is_signature_event = 0;
  RAISE NOTICE 'Rows updated to tournament shape: %', v_count;
  -- Expected: 1
END $$;
