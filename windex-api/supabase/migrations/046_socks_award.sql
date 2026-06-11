-- Migration 046: FJ Socks — explicit last-place award on championship_results.
--
-- League tradition: last place wins the FJ Socks. Design decision (locked):
-- socks are an EXPLICITLY RECORDED award (admin-set flag), not inferred from
-- finish-order completeness — historical seasons have known awards but
-- unknown middle placements, so "max place in a complete order" is not a
-- reliable derivation.
--
-- Shape: place becomes nullable; is_last_place is the award flag. The
-- historical-backfill shape is place=NULL + is_last_place=true ("finished
-- last, field size unknown"). A CHECK guarantees every row still records a
-- placement, an award, or both — never an empty row.
--
-- Trigger audit against 032 for NULL-place tolerance (no changes needed):
--   * sync_seasons_cup_champion(): selects WHERE place = 1 — a NULL place
--     never equals 1, so award-only rows are ignored and can never become
--     champion. The CHECK and the sync function agree.
--   * championship_results_check_group_match(): references season_id /
--     group_id only; place-agnostic.
--   * championship_results_check_membership(): references season dates and
--     group_members only; place-agnostic.
--   * Existing CHECK (place >= 1): NULL evaluates to unknown, which passes —
--     standard SQL CHECK semantics; nullability is governed by the new
--     constraint below.

ALTER TABLE public.championship_results
  ADD COLUMN IF NOT EXISTS is_last_place BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.championship_results
  ALTER COLUMN place DROP NOT NULL;

-- Every row records a placement, an award, or both.
ALTER TABLE public.championship_results
  DROP CONSTRAINT IF EXISTS championship_results_place_or_award;
ALTER TABLE public.championship_results
  ADD CONSTRAINT championship_results_place_or_award
  CHECK (place IS NOT NULL OR is_last_place);

COMMENT ON COLUMN public.championship_results.is_last_place IS
  'FJ Socks: explicit last-place award, set by an admin. Not derived from place. place=NULL + is_last_place=true is the historical-backfill shape (finished last, field size unknown).';

COMMENT ON COLUMN public.championship_results.place IS
  'Finishing place (standard competition ranking; ties share a place). NULL only for award-only rows — see championship_results_place_or_award.';
