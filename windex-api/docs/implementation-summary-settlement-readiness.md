# Implementation Summary: Settlement-Ready Schema (Minimal)

## Migration added

- **`supabase/migrations/004_money_delta.sql`**
  - Adds `money_delta DOUBLE PRECISION NULL` to `league_scores`.
  - No new tables. No `settled_at` on `league_rounds`.

## Standings logic unchanged

- **season_standings** view is unchanged. It still:
  - Uses only `league_rounds` and `league_scores`.
  - Computes `rounds_played` and `total_points` from effective points only (`COALESCE(score_override, score_value)`).
  - Does not reference `money_delta`, net_winnings, or any settlement state.
- **get-standings** endpoint unchanged; still returns standings ordered by `total_points` descending.

## Code paths changed

- **Ingest:** No code changes. New rows in `league_scores` do not set `money_delta`; the column remains NULL. Points and win_loss_override behavior unchanged.
- **No other application code** was modified.

## Docs updated

- **docs/api.md**
  - Terminology: league_rounds = events, league_scores = event results, score_value = points outcome.
  - Standings defined as points-only; money and settlement do not affect them.
  - `money_delta` described as for settlement/Venmo only, nullable until settlement rules exist.
  - New “Settlement readiness (money_delta)” section.
- **docs/architecture-review.md**
  - `league_scores` schema table updated to include `money_delta`.
  - Note that standings use only effective points; `money_delta` not in view.
  - Settlement section updated to reflect 004 and that no settlements table or settled_at exist.

## Remaining decisions before settlement generation

- **When to set money_delta:** Which process (e.g. Edge Function, cron, or manual step) computes and writes `money_delta` per league_scores row.
- **Payout formula:** How points (and optional group/season config) map to currency deltas (e.g. per-point value, caps, ties).
- **Settlement scope:** Whether to add a settlements table or `settled_at` (or similar) later to track which rounds/players have been settled.
- **Venmo integration:** How settlement records (e.g. rows with non-null `money_delta`) are turned into Venmo insert payloads; not in scope for this schema step.
