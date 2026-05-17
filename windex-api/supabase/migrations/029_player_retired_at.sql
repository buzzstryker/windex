-- Migration 029: player retirement (Phase 1 — visibility only).
--
-- Adds a dedicated, orthogonal retirement marker to public.players.
--
-- Why a new column instead of reusing is_active: the season_standings view
-- (migrations 018/019) anchors on group_members and filters
-- `WHERE gm.is_active = 1`, so setting group_members.is_active = 0 ERASES a
-- player's scored rounds from all historical standings. players.is_active has
-- its own separate "inactive" meaning and is edited in lockstep with the
-- membership flag. Neither can express "retired but history preserved".
--
-- Single-axis model: retirement is expressed ONLY by retired_at. Retired
-- players keep is_active = 1 on BOTH players and group_members so every
-- historical/standings surface (season_standings, get-points-matrix, cup
-- champion name resolution, activity_events) continues to include them. Only
-- operational lists (admin Players default tab, add-to-group pickers, the
-- expo Add Round score-entry picker, active member counts) filter on
-- retired_at IS NULL.
--
-- Backward-compatible / inert on deploy: the column is nullable with no
-- default, so every existing row is retired_at IS NULL (= not retired) and
-- no behavior changes until a player is explicitly retired.
--
-- Phase 2 (deferred, see BACKLOG): harden am_i_group_member() /
-- am_i_group_admin() to also require retired_at IS NULL, so a future retired
-- player with their own auth row cannot act on group data.

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_players_retired_at
  ON public.players (retired_at)
  WHERE retired_at IS NOT NULL;

COMMENT ON COLUMN public.players.retired_at IS
  'Non-null = player retired/resigned at this time. Orthogonal to is_active; '
  'operational lists hide retired players, historical/standings views are '
  'unaffected. Retirement keeps group_members.is_active=1 so season_standings '
  'still includes their scored rounds.';
