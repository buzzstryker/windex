# Windex — Backlog

- **Future access-control review:** Evaluate whether round-level actions should authorize by `league_rounds.user_id` or by group-based permissions derived from membership/role in the associated group.

- **Scorekeeper integration:** When Scorekeeper is ready, wire up `POST /ingest-event-results` as the submission target after a round is scored. Requirements:
  - Player ID mapping between Scorekeeper and Windex (use `player_mappings` table with `source_app = "scorekeeper"`)
  - Use `source_app = "scorekeeper"` and `external_event_id` for idempotency (prevents duplicate rounds)
  - Send `game_points` per player — Windex computes the head-to-head differential (`score_value = N × game_points - round_total`) server-side
  - Reference `shared-golf-types` for shared player/round TypeScript types
  - Scorekeeper does NOT need to compute standings or differentials — Windex handles all aggregation
  - Test with the adapter pattern in `windex-api/adapters/` and `docs/SOURCE_ADAPTERS.md`

- ~~**Round edit/delete permission enforcement:**~~ **Done.** Edit/delete buttons on Round Detail are now hidden for members. `GroupContext` resolves `isSuperAdmin` and `isGroupAdmin(groupId)` on login via RPC. Backend RLS enforces at DB level as backup.
