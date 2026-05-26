-- Migration 034: broadcast_notes_log.input_data — log the round/season payload
-- sent to Claude (stage 1) and Perplexity (stage 2) for full audit traceability.
--
-- The fact_check_audit column (033) records what Perplexity thought of each
-- claim. This column records the underlying data those claims were made from,
-- so a claim like "FJ has 7 wins in 9 signature events" can be traced back
-- to the exact payload rows that supported it.
--
-- Write semantics match fact_check_audit:
--   NULL      — function aborted before stage 1, no payload was ever sent.
--   populated — the payload sent to Claude stage 1 (identical to what stage 2
--               received). Best-effort write, never blocks the user-facing
--               response.

ALTER TABLE public.broadcast_notes_log
  ADD COLUMN IF NOT EXISTS input_data jsonb;

COMMENT ON COLUMN public.broadcast_notes_log.input_data IS
  'Round/season payload sent to Claude stage 1 (and stage 2 Perplexity). '
  'NULL = function aborted before any LLM call. Populated = the exact payload '
  'used. Written best-effort; never blocks the user-facing response.';
