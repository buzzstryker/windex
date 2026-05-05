# Windex — API Spec

Endpoints, request/response shapes, auth, and errors for late-add-api. Full contract, validation rules, and error codes: [late-add-api/docs/api.md](./late-add-api/docs/api.md). For terms (Group, Season, Event, Result, Standings, Source app, Attribution) see [README — Terminology](./README.md#terminology).

---

## Base URL and auth

- **Base:** `https://ftmqzxykwcccocogkjhc.supabase.co/functions/v1`.
- **Auth:** Bearer JWT (Supabase Auth). All endpoints require a valid token; RLS and ownership checks apply.

## Endpoints (summary)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/ingest-event-results` | Create one league round and league_scores (event results). Body: `group_id`, `round_date`, `scores[]`; optional `season_id`, `source_app`, `external_event_id` for idempotency. |
| GET | `/get-standings` | Read season standings. Query: `season_id`, optional `group_id`. Returns points-only (rounds_played, total_points). |
| POST | `/compute-money-deltas` | Round-scoped: compute and write `league_scores.money_delta` for one round from group payout config (`groups.dollars_per_point`). Body: `league_round_id`. No-op if config not set. |
| POST | `/generate-payment-requests` | Round-scoped: read `money_delta` for one round, return minimal payer→payee requests (amount_cents). Body: `league_round_id`. Does not persist. **Note:** This endpoint implements the "Quick Payout" (minimized transactions) algorithm only. The "Full Payout" (every loser→winner) is computed client-side in the Expo app using `score_value × dollars_per_point`. |
| GET | `/get-points-analysis` | Head-to-head point comparison between two players. Query: `group_id`, `player_a_id`, `player_b_id`, optional `season_id`. Returns lifetime + per-season breakdown with per-round detail. Consumed by both late-add-admin and late-add-expo. |
| GET | `/get-points-matrix` | All-vs-all game points differential matrix for a group. Query: `group_id`, optional `season_id`, `exclude_signature_events` (default true). Returns player list, pairwise cells (net + rounds), and top 10 worst matchups. Consumed by both late-add-admin and late-add-expo. |

Details (request/response shapes, validation, error codes): see **late-add-api/** in this directory: [docs/api.md](./late-add-api/docs/api.md), [payout-configuration-design.md](./late-add-api/docs/payout-configuration-design.md), [settlement-calculation-design.md](./late-add-api/docs/settlement-calculation-design.md).

## Types (request / response)

- Ingest: `scores[]` with `player_id`, `score_value` (points) or `result_type` (win/loss/tie). Points are determined by the source or admin; Windex stores and aggregates them and does not compute golf competition formats.
- Standings: `{ standings: [ { season_id, group_id, player_id, rounds_played, total_points } ] }`.
- Payment requests: `{ league_round_id, requests: [ { from_player_id, to_player_id, amount_cents } ] }`.
- Points analysis (head-to-head): `{ player_a, player_b, lifetime: { rounds_together, net_points, player_a_wins, player_b_wins, ties }, by_season: [ { season_name, rounds_together, net_points, rounds: [ { round_date, player_a_points, player_b_points, net } ] } ] }`.
- Points matrix (all-vs-all): `{ players: [ { id, display_name } ], cells: { [a]: { [b]: { net, rounds } } }, matchups: [ { player_a, player_b, net, rounds, avg_per_round } ] }`.

All points analysis and matrix computation is **server-side** in Edge Functions. Both late-add-admin and late-add-expo call the same endpoints and render the response without client-side computation.

## References

- [Master Spec](./Windex_Master_Spec.md)
- [Data Model](./Windex_Data_Model.md)
- [bootstrap-late-add-api.md](./bootstrap-late-add-api.md) (first endpoints)
- [late-add-api/docs/](./late-add-api/docs/) — full API contract, settlement and payout design, backlog
