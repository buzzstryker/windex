# Admin UI read/update endpoints — implementation summary

Minimum backend support for the Windex admin UI (dashboard, events, round entry, round edit, standings, groups). Implemented as Supabase Edge Functions; RLS applies.

---

## Endpoints implemented

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/groups` | List groups for dropdowns, filters, group list |
| GET | `/seasons?group_id=` | List seasons (optional filter by group) |
| GET | `/events?group_id=&season_id=&source_app=&from_date=&to_date=` | List events for dashboard and events page |
| GET | `/events/:eventId` | Event detail + results; `player_name` from `players` when present |
| PATCH | `/events/:eventId` | Round edit / override (metadata and/or results) |
| GET | `/players?group_id=` | Canonical players list; optional `group_id` = active members of that group (round entry picker, player mapping) |
| GET | `/get-standings` | Standings; response includes `player_name` from `players` when present |
| GET | `/standings-player-history?group_id=&season_id=&player_id=` | Standings drilldown: round-level point history for one player in group/season (read-only) |
| GET | `/review/player-mapping` | Pending player-mapping queue (admin); returns `items` for queue list |
| POST | `/review/player-mapping/:id/resolve` | Resolve mapping: body `{ "player_id": "<canonical id>" }`; marks queue item resolved and persists to `player_mappings` |
| GET | `/review/attribution` | Pending attribution queue (admin); returns `items` (rounds with `attribution_status = pending_attribution`) |
| POST | `/review/attribution/:id/resolve` | Resolve attribution: body `{ "group_id", "season_id"? }`; updates round and sets `attribution_status = attribution_resolved` |

Auth: all require `Authorization: Bearer <JWT>` (Supabase Auth). Unauthorized → 401.

---

## Response shapes (brief)

### GET /groups

```json
{
  "groups": [
    { "id": "string", "name": "string", "section_id": "string | null" }
  ]
}
```

### GET /seasons

```json
{
  "seasons": [
    { "id": "string", "group_id": "string", "name": null, "start_date": "string", "end_date": "string" }
  ]
}
```

`name` is always `null` (seasons table has no name column). UI can display `start_date – end_date`.

### GET /events (list)

Optional query: `?status=processed|partial_unresolved_players|validation_error` to filter by processing status.

```json
{
  "events": [
    {
      "id": "string",
      "external_event_id": "string | null",
      "source_app": "string | null",
      "round_date": "string",
      "group_id": "string",
      "group_name": "string | null",
      "season_id": "string | null",
      "season_name": "string | null",
      "status": "processed | partial_unresolved_players | validation_error",
      "unresolved_player_count": 0,
      "created_at": "string",
      "updated_at": "string | null"
    }
  ]
}
```

Status comes from `league_rounds.processing_status` (migration 008). Optional `?attribution_status=` filter (e.g. `pending_attribution`). List and detail include `attribution_status` (migration 009). Partial ingest sets `partial_unresolved_players` and `unresolved_player_count`.

### GET /events/:eventId (detail)

Same as list item, plus:

- `results`: `[{ "player_id", "player_name", "score_value", "score_override", "result_type", "override_reason?", "override_actor?", "override_at?" }]` — each row is a player’s points; when a point row has an override, audit fields are included for UI display.
- `attribution_status`: `"attributed"`
- `validation_errors`: `[]`
- `mapping_issues`: when status is `partial_unresolved_players`, includes a note to resolve in Player Mapping

`player_name` from `players` when present. Event detail shows unresolved count and links operators to Player Mapping when status is partial.

### PATCH /events/:eventId

**Request body:** `{ "round_date"?, "season_id"?, "results"?, "override_actor"?, "override_reason"? }`

**Response:** Same shape as GET /events/:eventId (updated event detail).

### GET /players

```json
{
  "players": [
    { "id": "string", "display_name": "string", "is_active": 1 }
  ]
}
```

Optional `?group_id=` returns only players that are active members of that group.

### GET /review/player-mapping

```json
{
  "items": [
    {
      "id": "uuid",
      "source_app": "string | null",
      "source_player_name": "string",
      "related_event_id": "string | null",
      "status": "pending",
      "candidate_players": []
    }
  ]
}
```

Only pending items are returned. Admin UI uses this for the queue list and detail panel.

### POST /review/player-mapping/:id/resolve

**Request:** `{ "player_id": "<canonical player id>" }`  
**Response (200):** `{ "ok": true }`  
Marks the queue item resolved and upserts into `player_mappings` (source → canonical) for future ingestion lookup.

---

## Schema gaps / notes

1. **No `status` on league_rounds** — All rounds are returned as `"processed"`. Attribution / player-mapping / validation status would require new columns or tables and are out of scope for this minimum set.
2. **No `name` on seasons** — Response uses `name: null`; UI derives display from `start_date` and `end_date`.
3. **Canonical players** — `players` table (migration 006): `id`, `user_id`, `display_name`, `is_active`; composite PK `(id, user_id)`. No FK from `group_members`/`league_scores`; display names looked up by id. Event detail and get-standings populate `player_name` when a matching player row exists; otherwise null (ready for future player-mapping).
4. **Override audit** — PATCH applies optional `override_actor` and `override_reason` to any result row with `score_override` set; defaults `"admin_ui"` / `"round_edit"` if omitted. `override_at` is set server-side.
5. **Recalculation** — Standings and any downstream effects are not recomputed inside these endpoints; they only read/write `league_rounds` and `league_scores`. Standings are computed on read via the existing `season_standings` view and `get-standings` function.
6. **Player mapping** — `player_mapping_queue` (pending unresolved source identities) and `player_mappings` (resolved source → canonical) are in migration 007. GET/POST review/player-mapping are implemented by the `review` Edge Function. **Ingest integration:** POST `/ingest-event-results` resolves source identity via `player_mappings` when `source_app` and per-player `source_player_ref` or `source_player_name` are provided; unresolved identities are enqueued to `player_mapping_queue` (one pending per identity, idempotent). See api.md for resolution order and duplicate-prevention rules.

**Attribution:** `league_rounds.attribution_status` (migration 009): `attributed`, `pending_attribution`, `attribution_resolved`. Ingest sets `pending_attribution` when `season_id` is omitted. GET/POST `/review/attribution` implemented by `review` Edge Function. Contract: `group_id` remains required at ingest; only “missing season” is supported for pending attribution without breaking existing ingestion.

**Follow-on gaps (out of scope for this pass):** No POST/PATCH for `players` (create/update canonical players); seed and manual DB insert only. No FK from `group_members` or `league_scores` to `players`; add later if referential integrity is required.

---

## Tests

- `tests/api_test.ts`: GET /groups, GET /seasons, GET /events, GET /events/:id, PATCH /events/:id, GET /players, GET /players?group_id=, GET /review/player-mapping, POST /review/player-mapping/:id/resolve, GET /review/attribution, POST /review/attribution/:id/resolve without auth → 401.
- Run: `deno test tests/api_test.ts --allow-net` (against Supabase Cloud). With seed data and auth, GET /players returns the two seed players (Player 1, Player 2); event detail and standings include `player_name` when players exist. Integration test includes GET queue → resolve first item → assert queue shrinks and `player_mappings` row exists.

---

## Full API docs

See [api.md](./api.md) for request/response details, validation, and error codes.
