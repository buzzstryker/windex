-- Close the WITH CHECK gap on the players_update RLS policy.
--
-- Migration 015 created players_update with a USING clause but no WITH CHECK,
-- so Postgres reused USING as the check. Effect: a non-super row owner could
-- change their own players.user_id to an arbitrary value (documented in
-- BACKLOG, surfaced 2026-06-15). Add an explicit WITH CHECK mirroring USING so
-- a non-super caller can only ever leave user_id = their own auth.uid(); super
-- admins retain full control.
--
-- Note: this is security hardening only. It is NOT the fix for the silent
-- player-name save bug — that was a client-side `Prefer: return=minimal` +
-- res.ok-only issue in windex-admin, fixed separately.

DROP POLICY IF EXISTS players_update ON players;
CREATE POLICY players_update ON players FOR UPDATE TO authenticated
  USING (am_i_super_admin() OR user_id = auth.uid())
  WITH CHECK (am_i_super_admin() OR user_id = auth.uid());
