-- Migration 031: broadcast_notes_log — audit trail for the "Broadcast Notes"
-- feature (LLM-generated playoff commentary per group).
--
-- Every call to the generate-broadcast-notes Edge Function inserts one row
-- here before returning. The insert is best-effort: a logging failure must
-- NOT break the user-facing generation (the function swallows insert errors
-- and still returns the notes). Rows are written by the Edge Function's
-- service-role client, which bypasses RLS — so there is intentionally NO
-- INSERT policy below.
--
-- Column notes:
--   group_id      TEXT  — matches groups.id (TEXT PK, migration 001).
--   player_ids    TEXT[]— matches players.id (TEXT, migration 006). The
--                         2-6 spotlight player ids for this generation.
--   spotlight_names TEXT[] — resolved display_names, parallel to player_ids,
--                         denormalized so the log is human-readable without
--                         a join (player rows can be renamed/retired later).
--   input_hash    TEXT  — sha256 of `${group_id}\n${player_ids sorted}`.
--                         FORWARD-LOOKING ONLY: there is no caching today.
--                         The intent is that a future revision can dedupe
--                         identical requests within a time window by looking
--                         up a recent row with the same input_hash instead
--                         of calling the LLM again. Stored now so historical
--                         rows are already keyed for that future feature.
--   output_length INT   — character length of the generated notes text.
--   generation_ms INT   — wall-clock ms for the Anthropic call (nullable;
--                         populated when measurable).
--   model         TEXT  — Anthropic model id used.
--
-- user_id is ON DELETE SET NULL so deleting an auth user (the documented
-- phantom-confirmation cleanup path) doesn't cascade-delete audit history.
-- group_id has no ON DELETE clause (default RESTRICT): groups are not
-- deleted operationally and the audit trail should not silently lose rows.

CREATE TABLE IF NOT EXISTS public.broadcast_notes_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  group_id        TEXT NOT NULL REFERENCES public.groups(id),
  player_ids      TEXT[] NOT NULL,
  spotlight_names TEXT[] NOT NULL,
  input_hash      TEXT NOT NULL,
  output_length   INT NOT NULL,
  generation_ms   INT,
  model           TEXT NOT NULL DEFAULT 'claude-sonnet-4-20250514'
);

CREATE INDEX IF NOT EXISTS idx_broadcast_notes_log_group_created
  ON public.broadcast_notes_log (group_id, created_at DESC);

-- Forward-looking lookup path for the future dedupe/caching feature
-- described above (find a recent row with an identical input_hash).
CREATE INDEX IF NOT EXISTS idx_broadcast_notes_log_input_hash
  ON public.broadcast_notes_log (input_hash, created_at DESC);

ALTER TABLE public.broadcast_notes_log ENABLE ROW LEVEL SECURITY;

-- Super admins can read the raw audit log; nobody else can. There is no
-- user-facing read path for this table (the feature returns notes directly
-- from the Edge Function response, not by reading this log).
DROP POLICY IF EXISTS broadcast_notes_log_super_admin_read ON public.broadcast_notes_log;
CREATE POLICY broadcast_notes_log_super_admin_read
  ON public.broadcast_notes_log
  FOR SELECT TO authenticated
  USING (am_i_super_admin());

-- No INSERT/UPDATE/DELETE policies: writes come exclusively from the Edge
-- Function's service-role client (RLS-exempt). Absent a permissive policy,
-- RLS denies these for every non-service-role caller by default.
