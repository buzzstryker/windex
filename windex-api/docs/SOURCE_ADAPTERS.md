# Source Adapters

Source adapters convert **external point totals** (from Scorekeeper, 18Birdies, Golf Genius CSV, or generic CSV) into the **ingest-event-results** API format. Windex does **not** ingest golf scorecard data (gross/net scores, hole-by-hole, strokes, birdies/pars). It only accepts **final awarded point totals** per player per event. Adapters do not compute points or apply golf rules; they normalize structure and identity so the pipeline can ingest rounds end-to-end.

---

## Adapter concept

- **Input:** External round data (e.g. one round, N players, **awarded point totals** per player — not golf scorecard or stroke data).
- **Output:** Request body for `POST /ingest-event-results` (group_id, season_id, round_date, source_app, external_event_id, scores[]).
- **Responsibility:** Map event id, round date, players, and point totals into the API shape. Map source identity (external id or name) to `source_player_ref` and/or `source_player_name` so the API can resolve or enqueue identities.

Adapters live in `windex-api/adapters/`. The ingest API remains the single entry point; adapters are a thin normalization layer used by scripts, cron jobs, or tests before calling the API.

---

## Expected input shape (external round)

A generic **external round** is a JSON (or parsed) object with:

| Field       | Type   | Required | Description |
|------------|--------|----------|-------------|
| `event_id` | string | No       | External event/round identifier. Becomes `external_event_id` for idempotency. |
| `round_date` | string | Yes    | Round date `YYYY-MM-DD`. |
| `scores`   | array  | Yes      | One entry per participant. |

Each element of `scores`:

| Field               | Type   | Required | Description |
|---------------------|--------|----------|-------------|
| `player_id`         | string | No*      | Canonical Windex player_id when already known. |
| `source_player_ref` | string | No*      | Stable id from the external system (preferred when available). |
| `source_player_name` | string | No*     | Display name from the external system. |
| `points`            | number | Yes      | **Awarded points** for the round (final point total from the source; not golf strokes or scorecard data). |

\* Each player row must have either `player_id` (canonical) or at least one of `source_player_ref` / `source_player_name` so the API can resolve or enqueue the identity.

**Player identity handling:**

- If the external system provides a **stable player id** (e.g. Scorekeeper user id, 18Birdies member id), send it as **source_player_ref**. The API uses it for lookup and for the mapping queue.
- If only **names** exist, send **source_player_name**. The API uses the trimmed name as the lookup key and enqueues unresolved identities for the Player Mapping UI.
- After an admin resolves an identity in Player Mapping, future ingests with the same `source_app` and ref/name will use the stored mapping and create `league_scores` under the canonical `player_id`.

---

## Normalizer

**`adapters/normalize.mjs`**

- **`normalizeToIngest(externalRound, options)`**  
  - `externalRound`: `{ event_id?, round_date, scores: [{ player_id?, source_player_ref?, source_player_name?, points }] }`  
  - `options`: `{ group_id, season_id?, source_app }`  
  - Returns a body ready for `POST /ingest-event-results`: `group_id`, `season_id`, `round_date`, `source_app`, `external_event_id` (if event_id provided), and `scores` with `score_value` and identity fields (`player_id` or `source_player_ref` / `source_player_name`).

---

## Generic CSV adapter

**`adapters/csv.mjs`**

- **`parseGenericCsv(csvText)`**  
  Parses a CSV string into the external round shape.  
  - **Required columns** (case-insensitive): **round_date** (or `date`), **player_name** (or `player`, `name`), **points** (awarded point total; column alias `score` or `pts` accepted).  
  - **Optional columns:** **event_id**, **source_player_ref** (or `player_ref`, `player id`).  
  - Header row required; delimiter comma. Data must be **point totals**, not golf stroke scores.  
  - Returns `{ event_id?, round_date, scores }` suitable for `normalizeToIngest()`.

Example CSV:

```csv
round_date,player_name,points,event_id,source_player_ref
2025-07-01,Player 1,3,my-event-001,sk-user-123
2025-07-01,Player 2,-1,my-event-001,sk-user-456
```

Use in a pipeline: `parseGenericCsv(csvText)` → `normalizeToIngest(round, { group_id, season_id, source_app })` → `POST /ingest-event-results` with the result.

---

## Example dataset and integration test

- **Fixture:** `tests/fixtures/external-round.json` — one round, 4 players: 2 with canonical `player_id` (player-1, player-2), 2 with only `source_player_name` (Alice From Export, Bob Unmapped) so they exercise the mapping queue.
- **Test:** `tests/adapter-ingest.mjs` (run with `npm run test:adapter`). It:
  1. Loads the fixture.
  2. Normalizes with `normalizeToIngest(..., { group_id, season_id, source_app: 'adapter-test' })`.
  3. POSTs to `ingest-event-results`.
  4. Asserts: one `league_rounds` row, two `league_scores` rows (resolved players only), at least two pending rows in `player_mapping_queue` (Alice, Bob), and standings updated for the resolved players.

Requires deployed functions on Supabase Cloud (same as main integration test) and `.env` with `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` from the Supabase Dashboard.

---

## Adding new sources later

1. **Define the source format**  
   Document the shape you get from the source (e.g. 18Birdies API response, Golf Genius CSV columns).

2. **Implement a parser**  
   In `adapters/`, add a module that converts that format into the **external round** shape above (event_id?, round_date, scores with identity + points). Reuse or mimic `csv.mjs` if the source is CSV; otherwise map the source’s fields to `event_id`, `round_date`, and `scores[].{ player_id?, source_player_ref?, source_player_name?, points }`.

3. **Reuse the normalizer**  
   Call `normalizeToIngest(parsedRound, { group_id, season_id, source_app: 'your_source_name' })` to get the ingest body. Use a stable `source_app` value so mappings and the queue are consistent.

4. **Call the API**  
   Send the normalized body to `POST /ingest-event-results` with a valid JWT. Idempotency is handled by the API when `source_app` and `external_event_id` are set.

5. **Optional: fixture + test**  
   Add a fixture under `tests/fixtures/` and an integration step (or test file) that runs the new parser → normalizer → ingest and asserts ledger and queue as in `adapter-ingest.mjs`.

---

## Glide ODS import (Windex)

To import a **Glide app export** (`.ods` from Glide) into Windex (all Glide fields have a place; see **[GLIDE_IMPORT_FIELD_MAPPING.md](./GLIDE_IMPORT_FIELD_MAPPING.md)**):

1. **Optional but recommended:** Sync structure so sections, groups, and seasons exist with the same IDs as in Glide:
   ```bash
   cd windex-api
   npm install
   npm run glide:sync-structure -- "path/to/YourExport.ods"
   ```
   Use the printed Group and Season IDs as `YOUR_GROUP_ID` and `YOUR_SEASON_ID` below.

2. **Optional but recommended:** Sync membership so players and group_members exist from UserProfiles (idempotent; same player in multiple groups → one player, multiple group_members):
   ```bash
   npm run glide:sync-members -- "path/to/YourExport.ods"
   ```
   See [GLIDE_MEMBERSHIP_SYNC_DESIGN.md](./GLIDE_MEMBERSHIP_SYNC_DESIGN.md).

3. **Convert ODS to ingest payloads**
   ```bash
   node scripts/convert-glide-ods-to-ingest.mjs "path/to/YourExport.ods" --group-id=YOUR_GROUP_ID --season-id=YOUR_SEASON_ID
   ```
   Writes one JSON per round under `glide-import/rounds/` with round date, submitted_at, scores_override, and per-player source fields (email, venmo, photo, role, is_active) for the queue.

4. **Run the import** (POST each round to the API):
   ```bash
   # Set GLIDE_IMPORT_TOKEN=Bearer_JWT or GLIDE_IMPORT_EMAIL / GLIDE_IMPORT_PASSWORD
   node scripts/run-glide-import.mjs
   ```
   Use `--dry-run` to print what would be sent without POSTing.

---

## Constraints

- **Points only:** Windex does not ingest or process golf scorecard data (gross/net scores, hole-by-hole, strokes, birdies/pars). Adapters assume the source provides **final awarded point totals** per player only.
- **No rules engine:** Adapters do not compute points, apply formats, or validate golf rules. External systems (or manual entry) supply final point totals.
- **Backend as source of truth:** Resolution, queue, and standings are handled by the ingest API and existing Windex logic.
- **Narrow responsibility:** Adapters only normalize data into the ingest API; they do not call the database or implement business rules.
