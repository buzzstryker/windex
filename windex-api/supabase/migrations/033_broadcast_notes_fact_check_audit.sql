-- Migration 033: broadcast_notes_log.fact_check_audit — store the Perplexity
-- fact-check audit alongside the existing per-generation audit row.
--
-- The generate-broadcast-notes Edge Function gained a three-stage pipeline:
--   1. Claude generates notes + a structured `claims` list.
--   2. Perplexity (sonar-pro) verifies each claim against the round/season
--      payload (round_data claims) or public web knowledge (general_knowledge
--      claims), returning per-claim annotations.
--   3. Claude integrates the corrections it agrees with, preserving its voice.
--
-- This column captures stage 2's annotations (plus the models used) so the
-- audit row reflects what the fact-check found. Like the rest of this row,
-- the write is BEST-EFFORT: a failure to persist the audit must NOT change
-- the user-facing response (which hard-fails on its own terms per the feature
-- spec). The function itself returns the fact-check in its HTTP response
-- regardless of whether this persistence succeeds.
--
-- NULL semantics (intentional):
--   NULL      — fact-check never ran (function aborted at stage 1, before any
--               Perplexity call). No fact-check was attempted.
--   populated — fact-check ran. On success the object holds the annotations.
--               On a hard-fail path (Perplexity errored/timed out, returned
--               malformed JSON, or stage-3 integration failed) the object
--               still records what happened via an `error` field, so the
--               audit trail is never silently empty for an attempted check.
--
-- Shape (jsonb):
--   {
--     "annotations":     [ { id, status, correction?, reasoning }, ... ],
--     "perplexity_model": "sonar-pro",
--     "claude_model":     "claude-sonnet-4-20250514",
--     "generated_at":     "<ISO 8601 timestamptz>",
--     "error":            "<reason>"   -- present only on hard-fail paths
--   }

ALTER TABLE public.broadcast_notes_log
  ADD COLUMN IF NOT EXISTS fact_check_audit jsonb;

COMMENT ON COLUMN public.broadcast_notes_log.fact_check_audit IS
  'Perplexity fact-check audit for this generation. NULL = fact-check never '
  'ran (aborted before stage 2). Populated = fact-check ran; includes an '
  '"error" field on hard-fail paths. Written best-effort; never blocks the '
  'user-facing response.';
