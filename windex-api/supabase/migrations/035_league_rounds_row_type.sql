-- Migration 035: league_rounds.row_type — structurally distinguish real rounds
-- from pre-2023 season aggregates.
--
-- Background: when Windex migrated from the Glide era, there was no per-round
-- data for 2020–2022. Each of those seasons was brought in as a single
-- league_rounds row holding the season-end points-race total per player, and
-- flagged is_signature_event = 1 purely so the rows would surface in reports.
-- That flag is wrong: these aren't signature events, and they contaminate every
-- signature/regular tournament stat (counts, W/L/T, money, head-to-head).
--
-- This migration adds a self-documenting row_type and reclassifies those three
-- rows as 'season_aggregate', clearing the misused is_signature_event flag.
--
-- Enum:
--   'signature_round'  — a real signature event round (e.g. the 2025 cup-day
--                        side games), is_signature_event = 1.
--   'regular_round'    — an ordinary league round (the overwhelming majority).
--   'season_aggregate' — a pre-2023 whole-season points total imported as one
--                        row. NOT a real round. Kept in the table because the
--                        season_standings VIEW sums league_scores over
--                        league_rounds with no flag filter, so these rows are
--                        the sole source of 2020–2022 points-championship
--                        totals (and thus points_champion_history). They are
--                        excluded from round-level tournament stats in code.
--
-- Default is 'regular_round': the backfill below sets row_type explicitly for
-- every existing row, so the default only governs FUTURE inserts — and a newly
-- ingested round is regular unless explicitly flagged signature.
--
-- Discriminator for the aggregates: round_date < '2022-12-01' (before the 2023
-- season start) AND is_signature_event = 1. Pre-flight confirmed this is
-- exactly the three 2020/2021/2022 rows (dated 2019/2020/2021-12-01); the only
-- other signature rows are the six 2025 cup-day rounds (dated 2025-11-30).
--
-- season_standings is a VIEW that filters on neither is_signature_event nor
-- row_type, so points_champion_history is preserved automatically. No rows are
-- deleted — only row_type and is_signature_event change.

-- 1. Column (default governs future inserts only).
ALTER TABLE public.league_rounds
  ADD COLUMN IF NOT EXISTS row_type TEXT NOT NULL DEFAULT 'regular_round';

-- 2. Allowed-values constraint.
ALTER TABLE public.league_rounds
  DROP CONSTRAINT IF EXISTS league_rounds_row_type_check;
ALTER TABLE public.league_rounds
  ADD CONSTRAINT league_rounds_row_type_check
  CHECK (row_type IN ('signature_round', 'regular_round', 'season_aggregate'));

-- 3. Backfill (order matters):
--    (a) pre-2023 signature aggregates → season_aggregate, clear the flag;
UPDATE public.league_rounds
   SET row_type = 'season_aggregate',
       is_signature_event = 0
 WHERE is_signature_event = 1
   AND round_date < '2022-12-01';

--    (b) remaining signature rows (now only the 2023+ real ones) → signature_round;
UPDATE public.league_rounds
   SET row_type = 'signature_round'
 WHERE is_signature_event = 1;

--    (c) everything else stays 'regular_round' (the column default applied at
--        ADD COLUMN time to all pre-existing rows; nothing further to do).

-- 4. Index for row_type-filtered queries.
CREATE INDEX IF NOT EXISTS idx_league_rounds_row_type
  ON public.league_rounds (row_type);

COMMENT ON COLUMN public.league_rounds.row_type IS
  'Row classification: signature_round | regular_round | season_aggregate. '
  'season_aggregate = pre-2023 whole-season points total imported as one row '
  '(not a real round; excluded from round-level tournament stats, but retained '
  'as the source of 2020-2022 points totals via the season_standings view).';

-- 5. Report the resulting breakdown (informational; not a hard assert since
--    counts are environment-specific).
DO $$
DECLARE
  v_agg INT; v_sig INT; v_reg INT;
BEGIN
  SELECT count(*) FILTER (WHERE row_type = 'season_aggregate'),
         count(*) FILTER (WHERE row_type = 'signature_round'),
         count(*) FILTER (WHERE row_type = 'regular_round')
    INTO v_agg, v_sig, v_reg
    FROM public.league_rounds;
  RAISE NOTICE 'league_rounds.row_type backfill: season_aggregate=%, signature_round=%, regular_round=%',
    v_agg, v_sig, v_reg;
END $$;
