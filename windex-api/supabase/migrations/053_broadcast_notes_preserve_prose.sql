-- Migration 053: broadcast_notes_log.notes — persist the generated commentary
-- prose on the audit row.
--
-- Until now only output_length (a character count) was stored. When stage 2
-- (Perplexity fact-check) or stage 3 (Claude integration) hard-failed, the
-- Edge Function returned an error and the stage-1 prose was thrown away — a
-- good, expensive generation destroyed by a downstream fact-check failure
-- (observed 2026-07-24: stage 1 produced 2350 chars + 33 claims, stage 2's
-- parser choked on trailing prose, and the generation was lost).
--
-- Storing the prose here means a fact-check failure no longer costs the
-- generation:
--   success        — holds the stage-3 revised prose (what we returned).
--   stage-2/3 fail — holds the stage-1 prose (what `notes` contains when
--                    writeAudit runs), so the generation is recoverable.
--   stage-1 abort  — writeAudit never runs, so no row and this stays absent.
--
-- Write semantics match the other audit columns (fact_check_audit 033,
-- input_data 034): best-effort, and a persistence failure never changes the
-- user-facing response. output_length continues to equal char_length(notes)
-- for any row that has notes.
--
-- Note: the sibling debug fields added alongside this change (parse_error,
-- raw_excerpt — the raw Perplexity output and parse error captured on a
-- malformed-JSON failure) live INSIDE the existing fact_check_audit jsonb
-- column and need no DDL; only this prose column is a new column.

ALTER TABLE public.broadcast_notes_log
  ADD COLUMN IF NOT EXISTS notes text;

COMMENT ON COLUMN public.broadcast_notes_log.notes IS
  'Generated commentary prose for this run. On success: the stage-3 revised '
  'notes. On a stage-2/3 failure: the stage-1 prose, preserved so a fact-check '
  'failure does not destroy a good generation. Absent when the function '
  'aborted before writeAudit ran (stage-1 failure). Written best-effort; '
  'never blocks the user-facing response. output_length = char_length(notes).';
