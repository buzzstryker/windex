# API

**Architectural boundary:** Windex operates as a **points ledger + standings aggregation platform**. It ingests or accepts **final point totals per player** (from external apps, manual admin entry, or admin override). It does **not** compute golf competition formats (Stableford, match play, best ball, skins, etc.); external systems or human admins determine points. Windex stores, maps, attributes, corrects, audits, and aggregates those points. Standings are **always derived** from atomic point records in the ledger; they are never edited directly.

**Terminology — “score” means points awarded only.** In Windex, “score” always refers to **awarded points** (the value stored and aggregated for standings). Windex does **not** ingest or process: gross golf scores, net scores, hole-by-hole scores, scorecards, birdies/pars/strokes, or any golf scorecard math. It only accepts **final awarded point totals** per player per event.

## Points ledger and standings

- **Points ledger:** The table `league_scores` is the canonical **atomic point record** layer: one row per (league_round_id, player_id) with effective points = `COALESCE(score_override, score_value)`. Ingest and round edit write only to `league_rounds` and `league_scores`; there is no separate mutable standings or totals table.
- **Standings derivation:** The view `season_standings` aggregates from `league_rounds` JOIN `league_scores` (rounds_played, total_points per player per season). Standings are **read-only** and reproducible from ledger rows. GET `/get-standings` reads this view; it does not write to any table.
- **Corrections:** Round edit / override updates atomic point rows in `league_scores` (and optionally metadata on `league_rounds`). Standings refresh on next read because they are computed from the ledger. See [POINTS_LEDGER_ARCHITECTURE.md](./POINTS_LEDGER_ARCHITECTURE.md) for full design.

## Terminology

- **league_rounds** = event records (one per round/event).
- **league_scores** = **points ledger**: one atomic point record per player per event. Each row stores **awarded points** only (no golf scorecard data). `score_value` = stored point total; `score_override` = corrected point total (with override_actor, override_reason, override_at). Effective points = `COALESCE(score_override, score_value)`.
- **Standings** = derived only from the ledger via view `season_standings` (rounds_played, total_points). No direct editing of standings; change ledger rows to change totals.
- **money_delta** on league_scores is for settlement requests / Venmo insert generation only. It may be null until settlement rules are implemented; it is not used in the standings view.

## Request flow: ingest → ledger → standings

1. **Valid JWT** — Client sends `Authorization: Bearer <JWT>` (Supabase Auth).
2. **POST** `/ingest-event-results` — Body: `group_id`, `round_date`, `scores[]` (and optional `source_app`, `external_event_id` for idempotency).
3. **league_rounds** — One row inserted (event record).
4. **league_scores** (ledger) — One row per player inserted (atomic point record: awarded points per player per round). `money_delta` is left null unless supplied or derived by future settlement logic.
5. **season_standings** — View is computed on read from `league_rounds` and `league_scores` using **effective points only**. No net_winnings or money in standings. Standings are never written; they are always derived from the ledger.

## Hardening (ingest)

- **Idempotency** — When `source_app` and `external_event_id` are both set, the round is uniquely identified by `(group_id, source_app, external_event_id)`. A second POST with the same triple returns **200** with the existing `league_round_id` (no duplicate). Race conditions are handled by catching unique violation 23505 and returning the existing row.
- **Duplicate submissions** — Safely rejected by the above: no second insert, same id returned.
- **Player membership** — Every resolved `player_id` (after source resolution) must be an active member of the group (`group_members` with `group_id` and `is_active = 1`). Otherwise **400** with `invalid_player_ids`.
- **Source player resolution** — When `source_app` is set, each point row may provide **source identity** instead of (or in addition to) `player_id`. See below.

---

## Ingest event results

**POST** `/ingest-event-results`

Creates one league round and its ledger rows (one per player: awarded points only). Auth required (Bearer JWT). Supports resolving source-player identities to canonical `player_id` via `player_mappings` and enqueueing unresolved identities to `player_mapping_queue`. Windex does not ingest golf scorecard data; only final point totals per player.

**Request body**

```json
{
  "group_id": "string",
  "season_id": "string (optional)",
  "round_date": "YYYY-MM-DD",
  "scores_override": false,
  "source_app": "string (optional)",
  "external_event_id": "string (optional)",
  "scores": [
    { "player_id": "string", "game_points": 80 },
    { "player_id": "string", "score_value": 2, "score_override": null },
    { "source_player_ref": "string (optional)", "source_player_name": "string (optional)", "score_value": 2 },
    { "player_id": "string", "result_type": "win" }
  ]
}
```

- **`game_points` mode (preferred for new rounds):** Each entry has `game_points` (raw positive game points). When ALL players provide `game_points`, the server computes `score_value` automatically. **Regular rounds:** `score_value = N × game_points - round_total` (h2h, zero-sum). **Tournament rounds** (`is_tournament=1`): `score_value = game_points - tournament_buyin` (zero-sum when pool balanced). Both `game_points` and the computed `score_value` are stored.
- **`score_value` mode (legacy/compatible):** Each entry has `score_value` (pre-computed differential). Used by Glide import and legacy ingestion. `game_points` is not stored.
- For **win_loss_override** mode: each entry has `result_type`: `"win"`, `"loss"`, or `"tie"`; the API stores equivalent points (1/0/0.5).

- `score_override` takes precedence over `score_value` when set.
- `scores_override`: when true, stored as 1 on `league_rounds` (scores treated as overrides).
- **(group_id, source_app, external_event_id)** — When both `source_app` and `external_event_id` are set, the round is uniquely identified by this triple. Idempotent: a second POST with the same triple returns **200** with the existing `league_round_id` (no duplicate insert). Under race conditions, a unique constraint violation is handled by returning **200** with the existing row.
- **Player membership** — Every resolved `player_id` must be an active member of the group. Otherwise **400** with `invalid_player_ids`.

### Source player resolution (when `source_app` is set)

Each point row must have either a **canonical** `player_id` or a **source identity** (`source_player_ref` and/or `source_player_name`). Resolution is exact-match only; no fuzzy matching.

**Resolution order (per player/row):**

1. If `player_id` is present and non-empty → use it (canonical). Validate membership.
2. Else if `source_app` is set and at least one of `source_player_ref` or `source_player_name` is present:
   - **Lookup key** = `source_player_ref` if present and non-empty, else `source_player_name` (trimmed).
   - Look up `player_mappings` by `(user_id, source_app, lookup_key)`.
   - **If mapping exists** → use `canonical_player_id` for this score; validate membership with the rest.
   - **If no mapping** → add a row to `player_mapping_queue` (see below) and **skip** this player’s points (no `league_scores` row). At least one player must resolve; otherwise **400** `no_resolved_scores`.
3. Else → **400** `score_identity_required` ("Each player/row must have player_id or (when source_app is set) source_player_ref or source_player_name").

**Assumptions:** `source_player_ref` is the preferred stable identifier from the source system (e.g. external id); when absent, `source_player_name` is used as the lookup key and for display. The same key is used for both `player_mappings` lookup and queue identity.

**Queue insertion (unresolved identities):** When a player row has source identity but no mapping, the ingest adds a row to `player_mapping_queue` with `user_id`, `source_app`, `source_player_name`, `source_player_ref` (if provided), `related_league_round_id` (the round being created), `status = 'pending'`. **Duplicate prevention:** at most one pending row per `(user_id, source_app, lookup_key)`; if a pending row already exists for that identity, no second row is inserted. So repeated ingests (e.g. same source identity in different events) do not create duplicate pending queue rows.

**Minimum for source adapters:** When sending point totals from an external source, set `source_app` and for each participant provide at least one of `source_player_ref` (preferred) or `source_player_name`. After an admin resolves the identity in the Player Mapping UI, future ingests will use the stored mapping and store that player’s points under the canonical `player_id`.

### Domain rules (business logic)

- **Points only — no golf scorecard data** — Windex stores **awarded point totals** only. It does not ingest or compute: gross/net golf scores, hole-by-hole scores, scorecards, or stroke counts. Each group has a `scoring_mode`:
  - **points**: `score_value` (or `score_override`) must be in the allowed points range (e.g. -10 to +10). Values that look like stroke counts (e.g. 72, 75) are rejected with **400** and `code: "raw_stroke_score_rejected"`. Out-of-range points return **400** and `code: "points_out_of_range"`.
  - **win_loss_override**: each entry must include `result_type`: `"win"`, `"loss"`, or `"tie"`. The API accepts this input and stores equivalent points (win=1, loss=0, tie=0.5) in `score_value` for aggregation; `result_type` is stored on `league_scores`. The outcome is determined by the source or admin; Windex does not compute match-play or other format logic.
- **Event structure** — A season belongs to exactly one group. If `season_id` is provided, it must belong to the same `group_id`; otherwise **400** and `code: "season_group_mismatch"`.
- **Attribution** — When `season_id` is omitted or null, the round is stored with `attribution_status = 'pending_attribution'` and appears in the attribution review queue. When `season_id` is provided and valid, `attribution_status = 'attributed'`. The ingest contract **requires** `group_id`; the narrowest support for pending attribution is “missing season” only. To support events with no group yet would require a schema/contract change (e.g. nullable `group_id` or placeholder group).
- **Override** — When `score_override` is set for a point row, `override_actor` and `override_reason` are required; the server sets `override_at`. Otherwise **400** and `code: "override_metadata_required"`.
- **Standings** — Standings aggregate event results (`league_rounds` + `league_scores`); effective points = `COALESCE(score_override, score_value)`. Only stored point totals matter for standings. Money and settlement state do not affect standings. Not from settlements.
- **Multi-group** — A result belongs to exactly one group. A player may belong to multiple groups; each submission is for one group only.

**Response**

- **200**: Idempotent: event already exists for this (group_id, source_app, external_event_id). `{ "id": "<uuid>", "league_round_id": "<uuid>" }`
- **201**: Created. `{ "id": "<uuid>", "league_round_id": "<uuid>" }`
- **400**: Invalid body, missing required fields; or `score_identity_required` (no player_id or source identity); or `no_resolved_scores` (all players unresolved); or one or more resolved `player_id`s not active members: `{ "error": "...", "invalid_player_ids": ["id1", ...] }`.
- **401**: Missing or invalid authorization.
- **500**: Insert failed (e.g. RLS or constraint).

## Get standings (minimal read)

**GET** `/get-standings?season_id=<uuid>`  
Optional: `&group_id=<uuid>`

Minimal read endpoint for standings by season (and optionally by group). Returns rows from the **read-only** view `season_standings`, which aggregates from the points ledger (`league_scores`). Standings are never edited directly; they are always derived from atomic point records. Auth required (Bearer JWT). RLS on underlying tables limits rows to the caller’s data.

**Response**

- **200**: `{ "standings": [ { "season_id", "group_id", "player_id", "player_name?", "rounds_played", "total_points" }, ... ] }`  
  Sorted by `total_points` descending. `player_name` is populated from the canonical `players` table when present; otherwise null.
- **400**: Missing `season_id`.
- **401**: Missing or invalid authorization.
- **500**: Query failed.

---

## Get player standings history (ledger drilldown)

**GET** `/standings-player-history?group_id=<uuid>&season_id=<uuid>&player_id=<uuid>`

Read-only. Returns round-level point records for one player in the given group/season so operators can see why that player has their total points (points-ledger drilldown). Auth required (Bearer JWT). RLS limits to the caller’s data.

**Query params**

- **group_id** (required)
- **season_id** (required)
- **player_id** (required)

**Response (200)**

```json
{
  "player_id": "<uuid>",
  "player_name": "Player 1",
  "total_points": 5,
  "rounds_played": 2,
  "history": [
    {
      "event_id": "<uuid>",
      "round_date": "2025-06-15",
      "effective_points": 2,
      "score_value": 2,
      "score_override": null,
      "source_app": "manual",
      "processing_status": "processed",
      "attribution_status": "attributed"
    },
    {
      "event_id": "<uuid>",
      "round_date": "2025-06-16",
      "effective_points": 3,
      "score_value": 0,
      "score_override": 3,
      "override_reason": "Points correction after review",
      "override_actor": "admin_ui",
      "override_at": "2025-06-16T12:00:00Z",
      "source_app": "manual",
      "processing_status": "processed",
      "attribution_status": "attributed"
    }
  ]
}
```

- **effective_points** = `COALESCE(score_override, score_value)` for that round (what counts toward standings).
- **score_override** non-null means the stored value was overridden (e.g. via round edit). When present, each history item may include **override_reason**, **override_actor**, and **override_at** for audit visibility in the UI.
- **history** is ordered by **round_date**.

**Errors**

- **400**: Missing `group_id`, `season_id`, or `player_id`.
- **401**: Missing or invalid authorization.
- **500**: Query failed.

---

## Get groups

**GET** `/groups`

Returns groups for dropdowns, filters, and group lists. Auth required (Bearer JWT). RLS limits to the caller’s groups.

**Response**

- **200**: `{ "groups": [ { "id", "name", "section_id" }, ... ] }`
- **401**: Missing or invalid authorization.
- **500**: Query failed.

---

## Get seasons

**GET** `/seasons?group_id=<uuid>` (optional)

Returns seasons, optionally filtered by `group_id`. Auth required. RLS limits to seasons of groups the caller owns.

**Response**

- **200**: `{ "seasons": [ { "id", "group_id", "name", "start_date", "end_date" }, ... ] }`  
  `name` is null (seasons table has no name column; UI may derive display from start_date/end_date).
- **401**: Missing or invalid authorization.
- **500**: Query failed.

---

## Get events (list)

**GET** `/events?group_id=&season_id=&source_app=&status=&from_date=&to_date=` (all query params optional)

Returns event list for dashboard and events page. Auth required. RLS limits to the caller’s league_rounds. **Status** comes from `league_rounds.processing_status` (see Event processing status below). Optional `status` filter: `processed`, `partial_unresolved_players`, `validation_error`.

**Response**

- **200**: `{ "events": [ { "id", "external_event_id", "source_app", "round_date", "group_id", "group_name", "season_id", "season_name", "status", "unresolved_player_count", "created_at", "updated_at" }, ... ] }`  
  `status` is one of `processed`, `partial_unresolved_players`, `validation_error`. `unresolved_player_count` is set when status is `partial_unresolved_players` (number of scores skipped at ingest).
- **401**: Missing or invalid authorization.
- **500**: Query failed.

---

## Get event by id (detail)

**GET** `/events/:eventId`

Returns one event with results for detail and round-edit load. Auth required.

**Response**

- **200**: Event detail: same fields as list item plus `results` (array of `{ player_id, player_name?, score_value, score_override, game_points?, result_type, override_reason?, override_actor?, override_at? }`). `game_points` = raw game points (NULL for legacy rounds). `score_value` = head-to-head differential. `player_name` from canonical `players` table. `attribution_status`, `validation_errors`, `mapping_issues` included.
- **404**: Event not found or access denied.
- **401**: Missing or invalid authorization.
- **500**: Query failed.

### Event processing status and attribution (league_rounds)

**Schema (migrations 008, 009):** `league_rounds.processing_status` (processed | partial_unresolved_players | validation_error), `league_rounds.unresolved_player_count`, `league_rounds.attribution_status` (attributed | pending_attribution | attribution_resolved).

- **processing_status** — Ingest outcome: `processed` (all players’ points resolved), `partial_unresolved_players` (some skipped), `validation_error` (reserved). Ingest sets `unresolved_player_count` when partial.
- **attribution_status** — Group/season attribution: `attributed` (normal, season_id provided at ingest), `pending_attribution` (season_id omitted; round appears in attribution queue), `attribution_resolved` (admin resolved via POST /review/attribution/:id/resolve).

GET /events and GET /events/:eventId return `status` (processing_status), `unresolved_player_count`, and `attribution_status`. Optional filter `?attribution_status=pending_attribution` on list. Detail includes `mapping_issues` when partial (player mapping).

---

## Update event (round edit / override)

**PATCH** `/events/:eventId`

Updates round metadata and/or results. Auth required. Only fields supported by the domain model are allowed. Recalculation (standings, etc.) remains backend responsibility.

**Request body**

```json
{
  "round_date": "YYYY-MM-DD (optional)",
  "season_id": "string | null (optional)",
  "results": [ { "player_id": "string", "score_value": number, "score_override": number | null }, ... ] (optional),
  "override_actor": "string (optional, default 'admin_ui')",
  "override_reason": "string (optional, default 'round_edit')"
}
```

- If `season_id` is set, it must belong to the same group as the round; otherwise **400** `season_group_mismatch`.
- When any result has `score_override` set, `override_actor` and `override_reason` are applied to those rows (defaults used if omitted).

**Response**

- **200**: Updated event detail (same shape as GET /events/:eventId).
- **400**: Invalid body or `season_group_mismatch`.
- **404**: Event not found or access denied.
- **401**: Missing or invalid authorization.
- **500**: Update failed.

---

## Get players (canonical player read model)

**GET** `/players?group_id=<uuid>` (optional)

Returns the canonical players list for the authenticated user. Used for round-entry player picker, display names in event detail/standings, and future player-mapping workflows. Auth required (Bearer JWT). RLS limits to the caller’s players (same user_id).

- Without `group_id`: returns all players for the user (`id`, `display_name`, `is_active`).
- With `group_id`: returns only players that are **active members** of that group (join with `group_members`).

**Response**

- **200**: `{ "players": [ { "id", "display_name", "is_active" }, ... ] }`
- **401**: Missing or invalid authorization.
- **500**: Query failed.

**Schema:** `players` table (migration 006): `id` (TEXT), `user_id` (UUID), `display_name` (TEXT), `is_active` (SMALLINT). Composite PK `(id, user_id)` so the same logical id can exist per user. No FK from `group_members` or `league_scores`; display names are looked up by id.

---

## Review: player mapping (admin queue and resolve)

Admin-focused workflow to resolve unresolved source-player identities to canonical players. Implemented by the `review` Edge Function (path prefix `/review/player-mapping`).

**Schema (migration 007):**

- **player_mapping_queue** — Queue of unresolved (and optionally resolved for audit) source-player identities. Columns: `id` (UUID), `user_id`, `source_app`, `source_player_name`, `source_player_ref` (optional), `related_league_round_id` (optional), `status` (`pending` | `resolved`), `canonical_player_id` (set when resolved), `created_at`, `updated_at`. RLS by `user_id`.
- **player_mappings** — Resolved mapping store for ingestion lookup. Columns: `id`, `user_id`, `source_app`, `source_player_ref`, `canonical_player_id`, `created_at`, `updated_at`. Unique `(user_id, source_app, source_player_ref)`. When an admin resolves a queue item, the function writes here so future ingestion can look up `canonical_player_id` by `(user_id, source_app, source_player_ref)` (using `source_player_ref` from the queue row, or `source_player_name` if ref is null).

**Ingest integration:** Implemented. POST `/ingest-event-results` accepts per-player `source_player_ref` and/or `source_player_name` when `source_app` is set; it looks up `player_mappings` by `(user_id, source_app, lookup_key)` and uses `canonical_player_id` when found; when not found, it adds a row to `player_mapping_queue` (idempotent per identity) and skips that player’s points. See “Source player resolution” under Ingest event results for resolution order and duplicate-prevention rules.

### GET /review/player-mapping

Returns pending player-mapping queue items for the authenticated user. Auth required (Bearer JWT). RLS limits to the caller’s queue rows.

**Response**

- **200**: `{ "items": [ { "id", "source_app", "source_player_name", "related_event_id?", "related_event_date?", "status", "candidate_players": [] }, ... ] }`  
  Only `status = 'pending'` rows are returned. `related_event_id` is `related_league_round_id` when set. `candidate_players` is reserved for future suggestions (currently empty).
- **401**: Missing or invalid authorization.
- **500**: Query failed.

### POST /review/player-mapping/:id/resolve

Marks a queue item resolved and persists the mapping to `player_mappings`. Auth required. Caller must own the queue item.

**Request body**

```json
{ "player_id": "<canonical player id>" }
```

- **player_id** (required): Canonical player id (must exist in `players` for the user; no FK enforced in this endpoint; validation can be added later).

**Behavior**

1. Load queue row by `id` and `user_id`; return 404 if not found.
2. If already `status = 'resolved'`, return 400.
3. Update queue row: `status = 'resolved'`, `canonical_player_id = player_id`, `updated_at = now()`.
4. Upsert `player_mappings`: `(user_id, source_app, source_player_ref, canonical_player_id)`. `source_player_ref` = queue’s `source_player_ref` if present, else `source_player_name`.

**Response**

- **200**: `{ "ok": true }`
- **400**: Missing `player_id` or already resolved.
- **404**: Mapping item not found or access denied.
- **401**: Missing or invalid authorization.
- **500**: Update or upsert failed.

**Follow-on gaps:** Resolve does not validate that `player_id` exists in `players` (no FK or existence check). `candidate_players` in the list response is not populated by the backend (reserved for future suggestions).

---

## Review: attribution (admin queue and resolve)

Admin workflow to resolve events that need group/season assignment. Implemented by the `review` Edge Function (path prefix `/review/attribution`). Queue = `league_rounds` where `attribution_status = 'pending_attribution'` (no separate table).

**Schema (migration 009):** `league_rounds.attribution_status` — `TEXT NOT NULL DEFAULT 'attributed'` with `CHECK (attribution_status IN ('attributed', 'pending_attribution', 'attribution_resolved'))`. Ingest sets `pending_attribution` when `season_id` is omitted; admin resolve sets `attribution_resolved` and updates `group_id`/`season_id`.

### GET /review/attribution

Returns rounds pending attribution for the authenticated user. Auth required (Bearer JWT). RLS limits to the caller’s league_rounds.

**Response**

- **200**: `{ "items": [ { "id", "event_id", "source_app", "round_date", "status", "group_id?", "season_id?" }, ... ] }`  
  `id` and `event_id` are the league_round id. `group_id`/`season_id` are the round’s current values (may be set from ingest).
- **401**: Missing or invalid authorization.
- **500**: Query failed.

### POST /review/attribution/:id/resolve

Assigns group and optional season to the round and marks attribution resolved. Auth required. Caller must own the round.

**Request body**

```json
{ "group_id": "<uuid>", "season_id": "<uuid> | null" }
```

- **group_id** (required): Group to assign. Must be owned by the user.
- **season_id** (optional): If provided, must belong to the specified `group_id`; otherwise **400** `season_group_mismatch`.

**Behavior**

1. Load round by `id` and `user_id`; return 404 if not found.
2. Validate `group_id` (user must own group).
3. If `season_id` provided, validate it belongs to `group_id`.
4. Update round: `group_id`, `season_id`, `attribution_status = 'attribution_resolved'`, `updated_at = now()`.

**Response**

- **200**: `{ "ok": true }`
- **400**: Missing `group_id` or `season_group_mismatch`.
- **404**: Event not found or group not found / access denied.
- **401**: Missing or invalid authorization.
- **500**: Update failed.

---

## Standings view (direct)

You can also query the `season_standings` view via PostgREST or SQL for per-season, per-player aggregates:

- `season_id`, `group_id`, `player_id`
- `rounds_played`
- `total_points` (sum of effective **points** only: `score_override ?? score_value`)

Standings do not include `money_delta` or net_winnings. RLS on underlying tables applies.

## Settlement readiness (money_delta)

`league_scores.money_delta` is a nullable numeric column reserved for settlement logic. It is intended for settlement requests and Venmo insert generation only. It is not populated by ingest and **is not used in standings**; standings remain **points-only** (rounds_played, total_points).

**Payout config (group-level):** `groups.dollars_per_point` — `DOUBLE PRECISION NULL`, with `CHECK (dollars_per_point IS NULL OR dollars_per_point >= 0)`. NULL = payout not configured (function returns `computed: false`, no write). 0 or positive = dollars per point of deviation from the round mean (zero-sum formula).

**Formula:** effective_points = COALESCE(score_override, score_value); round_mean = average(effective_points) over the round’s league_scores; money_delta = (effective_points − round_mean) × dollars_per_point. Values are rounded to 2 decimal places; a deterministic residual adjustment is applied so the round remains zero-sum (see [payout-configuration-design.md](./payout-configuration-design.md)).

**Calculation flow:** POST `/compute-money-deltas` with `league_round_id` loads the round’s group, reads `groups.dollars_per_point`, and if set computes and writes only `league_scores.money_delta` for that round. No settlements table.

### Compute money deltas

**POST** `/compute-money-deltas`

Round-scoped: computes and writes `league_scores.money_delta` for one round only. Does not change standings or any other columns. Idempotent: re-run overwrites money_delta for that round.

**Request body**

```json
{ "league_round_id": "<uuid>" }
```

**Auth:** Bearer JWT. Same RLS as ingest/get-standings; caller must have access to the round (e.g. league_rounds owned by user).

**Response**

- **200** — Success.
  - If payout config is **not** set (`groups.dollars_per_point` NULL): `{ "league_round_id": "<uuid>", "computed": false, "reason": "no_payout_config", "message": "..." }`. No rows updated; `money_delta` remains NULL. Distinguishes “not computed yet” from “computed to zero”.
  - If payout is configured and computation ran: `{ "league_round_id": "<uuid>", "computed": true, "updated": N }` (N = count of league_scores updated). Sum of money_delta for the round is zero (zero-sum); values rounded to 2 decimals with residual applied to one row (see design doc).
- **400** — Missing or invalid `league_round_id` (e.g. `code: "missing_league_round_id"`).
- **401** — Missing or invalid authorization.
- **404** — Round not found or access denied (`code: "round_not_found"`).
- **500** — Load or update failed.

### Generate payment requests

**POST** `/generate-payment-requests`

Round-scoped: reads `league_scores.money_delta` for one round and returns the minimal set of payer → payee requests. **Does not write to the database**; requests are generated on demand and not stored. Windex does not track payment completion or maintain a settlement ledger.

**Request body**

```json
{ "league_round_id": "<uuid>" }
```

**Auth:** Bearer JWT. Same access pattern as compute-money-deltas; caller must have access to the round.

**Read path:** Loads the target `league_rounds` row (with existing auth/RLS behavior) and `league_scores` for that round. Requires `money_delta` to be non-null for all ledger rows (i.e. compute-money-deltas must have been run for the round).

**Validation**

- `money_delta` is converted to integer cents (`Math.round(money_delta * 100)`) before matching.
- The round must be **zero-sum in cents** (sum of rounded cents = 0). If not, returns **400** with `code: "round_not_zero_sum"`.
- If any `money_delta` is null, returns **400** with `code: "money_delta_not_computed"`.

**Matching:** Positive balances are payees, negative are payers. A deterministic greedy algorithm produces the minimal practical set of requests: sort by absolute amount descending, then `player_id` ascending as tie-breaker; match payers to payees in that order.

**Response (200)**

```json
{
  "league_round_id": "<uuid>",
  "requests": [
    { "from_player_id": "<payer>", "to_player_id": "<payee>", "amount_cents": 300 }
  ]
}
```

- **All zero deltas** → `requests: []`.
- **One player only** → `requests: []`.

**Errors**

- **400** — Missing `league_round_id` (`code: "missing_league_round_id"`), or `money_delta` not computed (`code: "money_delta_not_computed"`), or round not zero-sum in cents (`code: "round_not_zero_sum"`).
- **401** — Missing or invalid authorization.
- **404** — Round not found or access denied (`code: "round_not_found"`).
- **500** — Load failed.

---

## Local seed and integration test

Deterministic seed data is in `supabase/seed.sql`: one section, one group, one season, two players (`player-1`, `player-2`) as active group members (and canonical `players` rows with display_name "Player 1", "Player 2"), and one test user `test@lateadd.local` / `testpass123`. Applied with `supabase db reset`.

The integration test (`npm run test:integration`) signs in as that user, POSTs a valid ingest with `source_app` and `external_event_id`, then asserts:

- One `league_rounds` row and two `league_scores` rows (atomic point records; via service role).
- GET `get-standings` returns correct `rounds_played` and `total_points` for the season (standings derived from ledger).
- Step 5b (points ledger): PATCH round edit updates `league_scores` rows; GET get-standings then reflects the change; no separate mutable standings table.
- Step 5c (standings drilldown): GET standings-player-history returns round-level point records for a player; total_points equals sum of effective_points; override reflected when present.
- Idempotent repeat POST returns 200 with the same `league_round_id`.
- compute-money-deltas: no config → computed: false; with config → computed: true, zero-sum, rerun idempotent, override recompute, all same points → all zero.
- generate-payment-requests: two-player one request, deterministic repeat, all zero deltas → empty requests, NULL money_delta → 400.
- POST with a non-member `player_id` returns 400 with `invalid_player_ids`.
- GET `review/player-mapping` returns seed queue item(s); POST resolve with `player_id` marks item resolved and inserts into `player_mappings`; queue list then has one fewer pending item.
- Ingest with source identity: scores using `source_player_name`/`source_player_ref` and `source_app` resolve via `player_mappings` (stored canonical `player_id` used); unresolved identities get one pending queue row (idempotent per identity); re-ingest with same unresolved identity does not create duplicate queue rows.
- Event processing status: partial ingest sets `processing_status = partial_unresolved_players` and `unresolved_player_count`; fully resolved ingest sets `processed` and 0; GET /events and GET /events/:id return status and count; list filter `?status=partial_unresolved_players` and detail `mapping_issues` for partial rounds.
- Step 18 (attribution): ingest without `season_id` sets `attribution_status = pending_attribution`; GET /review/attribution returns that round; POST resolve with `group_id` and `season_id` → 200; round has `attribution_resolved` and updated group_id/season_id; round no longer in queue; event list/detail include `attribution_status`.

Requires `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` from the Supabase Dashboard (set in `.env` or environment).

**Domain rule tests** (`npm run test:domain`) assert core business rules using the same seed and env:

- Valid points ingest; reject raw stroke scores (e.g. 72, 75) and out-of-range points in points mode.
- Event structure: reject `season_id` that belongs to another group.
- Membership: reject non-member players with `invalid_player_ids`.
- Idempotency: same `external_event_id` twice returns 200 and no duplicate rows.
- Override: require `override_actor` and `override_reason` when `score_override` is set; standings use effective result.
- win_loss_override: `result_type` win/loss/tie accepted and stored as points (1/0/0.5); standings from event results.
- Multi-group: one result per group; player can be in multiple groups; no cross-group ambiguity in standings.
- Payout: no config (dollars_per_point NULL) → computed: false; with config → computed: true, zero-sum; standings remain points-only.
- Payment requests: generate-payment-requests reads money_delta, validates zero-sum in cents, returns minimal payer→payee list; not persisted; Windex does not track payment completion.

---

## Points Analysis — head-to-head comparison

**GET** `/get-points-analysis`

Head-to-head point comparison between two players. All computation is server-side. Consumed by both windex-admin and windex-expo.

**Query params**

- **group_id** (required)
- **player_a_id** (required)
- **player_b_id** (required)
- **season_id** (optional — if omitted, returns all 2023+ seasons)
- **exclude_signature_events** (optional, default `true` — excludes rounds flagged `is_signature_event = 1`)

**Logic**

- Only includes rounds where BOTH players have a `league_score` entry for the same `league_round_id`.
- Points = `COALESCE(score_override, score_value)`.
- Filters to 2023+ seasons (start_date >= 2022-12-01) unless a specific `season_id` is requested.
- Excludes signature events by default.
- Win = round where that player's points > opponent's points.

**Response (200)**

```json
{
  "group_id": "...",
  "player_a": { "id": "...", "display_name": "..." },
  "player_b": { "id": "...", "display_name": "..." },
  "lifetime": {
    "rounds_together": 0,
    "player_a_total_points": 0,
    "player_b_total_points": 0,
    "net_points": 0,
    "player_a_wins": 0,
    "player_b_wins": 0,
    "ties": 0
  },
  "by_season": [
    {
      "season_id": "...",
      "season_name": "2026",
      "rounds_together": 0,
      "player_a_total_points": 0,
      "player_b_total_points": 0,
      "net_points": 0,
      "player_a_wins": 0,
      "player_b_wins": 0,
      "ties": 0,
      "rounds": [
        {
          "league_round_id": "...",
          "round_date": "2026-01-15",
          "player_a_points": 42,
          "player_b_points": -42,
          "net": 84
        }
      ]
    }
  ]
}
```

**Errors**

- **400**: Missing required params.
- **401**: Missing or invalid authorization.
- **404**: One or both players not found.

---

## Points Matrix — all-vs-all differential

**GET** `/get-points-matrix`

All-vs-all game points differential matrix for a group. All computation is server-side. Consumed by both windex-admin and windex-expo.

**Query params**

- **group_id** (required)
- **season_id** (optional — if omitted, includes all 2023+ seasons)
- **exclude_signature_events** (optional, default `true`)

**Logic**

- Fetches all rounds and scores for the group.
- Filters to 2023+ seasons and (optionally) excludes signature events.
- Only includes active group members in the matrix.
- Computes pairwise net points and round counts for every player pair.
- Returns top 10 worst matchups (minimum 3 shared rounds, sorted by avg per round ascending).

**Response (200)**

```json
{
  "group_id": "...",
  "season_id": null,
  "exclude_signature_events": true,
  "players": [
    { "id": "...", "display_name": "FJ" },
    { "id": "...", "display_name": "Buzz" }
  ],
  "cells": {
    "player_a_id": {
      "player_b_id": { "net": 123, "rounds": 5 }
    }
  },
  "matchups": [
    {
      "player_a": "...",
      "player_b": "...",
      "net": -100,
      "rounds": 10,
      "avg_per_round": -10.0
    }
  ]
}
```

- `players` is sorted by total net points descending (strongest first).
- `cells[a][b].net` = player A's total points minus player B's total points across shared rounds.
- `matchups` = top 10 worst per-round averages across all player pairs.

**Errors**

- **400**: Missing `group_id`.
- **401**: Missing or invalid authorization.
