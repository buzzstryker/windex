# Points Ledger + Standings Aggregation Architecture

Windex operates as a **points ledger plus standings aggregation platform**. It stores only **awarded point totals** per player per event — no golf scorecard data, hole-by-hole scores, or stroke counts. Standings are always **derived** from atomic point records; they are never edited directly.

---

## 1. Architectural decision

**Decision: Option A — Treat `league_scores` as the points ledger and formalize that in schema, code, and docs.**

No new table was added. The existing `league_scores` table is the canonical atomic point record layer.

---

## 2. Reasoning

- **One atomic point record per player per round:** `league_scores` already has `UNIQUE(league_round_id, player_id)`. One row per (event, player) with `score_value`, `score_override`, and effective points = `COALESCE(score_override, score_value)`.
- **Auditability:** Override is tracked with `override_actor`, `override_reason`, `override_at` on the same row. No separate revision table required for v2.
- **Correction/override:** Round edit (PATCH /events/:id) updates `league_scores` rows in place; standings refresh automatically because they are computed from the view over `league_scores`.
- **Standings aggregation:** `season_standings` is a **view** over `league_rounds` JOIN `league_scores`. It has no storage; `total_points` and `rounds_played` are computed on read. There is no separate mutable “standings” or “totals” table anywhere in the codebase.
- **Ingest and manual entry:** Both write only to `league_rounds` and `league_scores`; neither touches any standings table (because none exists).

A dedicated `points_ledger` table would duplicate this model and add migration cost without a clear v2 benefit. Option B would be justified only if we needed multiple point records per player per round (e.g. revision history) or a different grain; for v2, in-place update with audit fields is sufficient.

---

## 3. Ledger concept (formalized)

The **points ledger** is implemented by the `league_scores` table. Conceptually each row represents:

| Concept | Implementation |
|--------|----------------|
| **player_id** | `league_scores.player_id` |
| **round/event id** | `league_scores.league_round_id` → `league_rounds.id` |
| **group_id** | Via `league_rounds.group_id` (join) |
| **season_id** | Via `league_rounds.season_id` (join) |
| **points value** | Effective = `COALESCE(league_scores.score_override, league_scores.score_value)` |
| **Source path (correction)** | When `score_override` is set: `override_actor`, `override_reason`, `override_at`. Otherwise value came from ingest or manual entry. |
| **Timestamps** | `league_scores.created_at`, `league_scores.updated_at` |

- **Ingest:** Inserts one `league_rounds` row and N `league_scores` rows. No other tables written.
- **Manual entry:** Same path (POST ingest-event-results).
- **Round edit / override:** Updates `league_rounds` (e.g. round_date, season_id) and/or `league_scores` (score_value, score_override, override_actor, override_reason, override_at). No other tables written.
- **Standings:** Read-only. Computed by the view `season_standings` from `league_rounds` JOIN `league_scores`; `get-standings` reads the view. No direct editing of standings; no separate mutable totals.

---

## 4. Standings derived from ledger only

- **View:** `season_standings` = `SELECT season_id, group_id, player_id, COUNT(DISTINCT lr.id) AS rounds_played, COALESCE(SUM(COALESCE(ls.score_override, ls.score_value)), 0) AS total_points FROM league_rounds lr JOIN league_scores ls ON ls.league_round_id = lr.id WHERE lr.season_id IS NOT NULL GROUP BY lr.season_id, lr.group_id, ls.player_id`.
- **API:** GET `/get-standings` queries this view and orders by `total_points` descending. It does not write to any table.
- **Invariant:** Standings are reproducible from atomic point rows in `league_scores` (and event/season linkage in `league_rounds`). There is no separate mutable standings or totals source of truth.

---

## 5. Correction / override at atomic point level

- Round edit (PATCH /events/:eventId) updates `league_scores` rows for that event: `score_value`, `score_override`, and when override is set, `override_actor`, `override_reason`, `override_at`.
- Standings automatically reflect the change on next read because the view aggregates from `league_scores`. No “recalculation” job or separate standings update is required.

---

## 6. Drilldown: player standings history

**Current state:** Event detail (GET /events/:id) returns results (points per player for that event). Standings (GET /get-standings) returns per-player totals for a season. There is no single endpoint that returns — now implemented: GET /standings-player-history “all point records for player X in season Y” (event-by-event breakdown).

**Endpoint:** GET `/standings-player-history?group_id=&season_id=&player_id=` returns round-level point records for that player in that season (event_id, round_date, effective_points, score_value, score_override, source_app, processing_status, attribution_status). Response includes `total_points`, `rounds_played`, and `history` array ordered by round_date. Overrides are visible via `score_override`. See api.md for full contract. The admin Standings screen uses this for the point-history drilldown (click a player row). “why does this player have N points?” ---

## 7. References

- Schema: `supabase/migrations/001_core_schema.sql` (view), `003_scoring_mode_and_override.sql` (override columns).
- Ingest: `supabase/functions/ingest-event-results/index.ts`.
- Round edit: `supabase/functions/events/index.ts` (PATCH).
- Standings: `supabase/functions/get-standings/index.ts` (reads view only).
- Standings drilldown: `supabase/functions/standings-player-history/index.ts` (GET; round-level point history for one player).
- Docs: `api.md`, `architecture-review.md`, root README, Master Spec, Data Model.
