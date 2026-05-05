# Glide v1 → Windex parity audit

Complete table-by-table and field-by-field parity assessment. **v1** = Glide app export (ODS: Sections, Groups, UserProfiles, Seasons, Rounds, Scores, Payout). **v2** = Windex schema, API, and import/sync paths.

---

## 1. Table-by-table matrix

| v1 table      | Purpose in v1 | Destination in v2 | Import / sync path | Status | Notes |
|---------------|---------------|-------------------|---------------------|--------|-------|
| **Sections**  | Group sections / grouping of leagues | `sections` | `sync-glide-structure.mjs` → Supabase upsert | **Fully mapped** | Same IDs (Glide Row ID = sections.id). Section/Name → name. |
| **Groups**    | Leagues; name, logo, section, admin, season start | `groups` | `sync-glide-structure.mjs` → Supabase upsert | **Fully mapped** | Row ID → id; name, logo_url, section_id, admin_player_id, season_start_month. Group/Created At not stored (v2 uses server timestamps). |
| **UserProfiles** | Users/players per group: identity, email, Venmo, role, photo, is_active, group link | `players` + `group_members` + `player_mapping_queue` + `player_mappings` | **Membership:** `sync-glide-members.mjs` creates/updates players and group_members from UserProfiles (idempotent; supports multi-group). Round ingest sends profile fields per score → queue; player_mappings from membership sync resolve ref → canonical player. | **Fully mapped** | Identity → players (merged by email when present). Each UserProfile row → one group_members row. Row ID → player_mappings so ingest resolves. See [GLIDE_MEMBERSHIP_SYNC_DESIGN.md](./GLIDE_MEMBERSHIP_SYNC_DESIGN.md). |
| **Seasons**   | Season windows per group (start/end date) | `seasons` | `sync-glide-structure.mjs` → Supabase upsert | **Fully mapped** | Row ID → id; group_id, start_date, end_date. |
| **Rounds**    | Events: date, submitted-at, scores override flag, group | `league_rounds` | `convert-glide-ods-to-ingest.mjs` + `run-glide-import.mjs` → POST ingest-event-results | **Fully mapped** | Row ID → external_event_id (idempotency); round_date, submitted_at, scores_override; group_id from args. |
| **Scores**    | Per-round, per-player points (value + override) | `league_scores` | Same ingest path as Rounds; scores[] in body | **Fully mapped** | Round/ID groups rows; Player/ID → resolved player_id or queue; Score/Value + Score/Score Override → score_value, score_override. |
| **Payout**    | Payout records (Glide app; exact semantics/columns may vary) | No direct table. v2 uses `league_scores.money_delta` + `groups.dollars_per_point`; payment requests generated on demand | **Not migrated** | **Intentionally not migrated.** v1 Payout sheet has at least 🔒 Row ID, Index (reference converter used only these). v2 computes money_delta from points and dollars_per_point; no stored payout rows; generate-payment-requests reads money_delta and returns payer→payee list (not persisted). |

---

## 2. Field-by-field matrix

### 2.1 Sections (v1)

| v1 field name | v2 field / destination | Transform | Import method | Status |
|---------------|------------------------|-----------|---------------|--------|
| 🔒 Row ID     | `sections.id`          | Use as primary key | sync-glide-structure | **mapped** |
| Section/Name  | `sections.name`       | None      | sync-glide-structure | **mapped** |

*v2 adds: `user_id`, `created_at`, `updated_at` (server/session).*

---

### 2.2 Groups (v1)

| v1 field name     | v2 field / destination | Transform | Import method | Status | Notes |
|--------------------|------------------------|-----------|---------------|--------|-------|
| 🔒 Row ID         | `groups.id`            | Use as primary key | sync-glide-structure | **mapped** | |
| Group/Name        | `groups.name`          | None      | sync-glide-structure | **mapped** | |
| Group/Logo        | `groups.logo_url`      | None      | sync-glide-structure | **mapped** | |
| Section/ID        | `groups.section_id`    | Glide section row ID → sections.id | sync-glide-structure | **mapped** | |
| Admin/ID          | `groups.admin_player_id` | None (may be player or user ref in Glide) | sync-glide-structure | **mapped** | |
| Season/Start Month| `groups.season_start_month` | Parse integer; default 1 | sync-glide-structure | **mapped** | |
| Group/Created At  | —                      | —         | —             | **intentionally dropped** | v2 uses server `created_at`/`updated_at` only. |

*v2 adds: `user_id`, `scoring_mode`, `dollars_per_point`, `created_at`, `updated_at`.*

---

### 2.3 UserProfiles (v1)

| v1 field name        | v2 field / destination | Transform | Import method | Status |
|----------------------|------------------------|-----------|---------------|--------|
| 🔒 Row ID            | `source_player_ref` (ingest), `player_mappings.source_player_ref`, eventual `players.id` | Identity key for resolution | ingest (per score) + resolve | **mapped** |
| Identity/Username    | `source_player_name` (ingest), `players.display_name` | **v1 standings show username;** v2 standings use display_name so they match | ingest; **sync-glide-members** → players.display_name (username, else name, else Row ID) | **mapped** |
| Identity/Name        | `players.full_name` | Real name; profile metadata only; not used in standings | **sync-glide-members** → players.full_name | **mapped** |
| Identity/Email       | `player_mapping_queue.source_email`; optional `players.email` on resolve | None | ingest (per score) → queue; optional copy to players on resolve | **mapped** |
| Identity/Venmo Handle| `player_mapping_queue.source_venmo_handle`; optional `players.venmo_handle` on resolve | None | ingest → queue; optional copy to players on resolve | **mapped** |
| Identity/Role        | `player_mapping_queue.source_role`; `group_members.role` | None | ingest → queue; **sync-glide-members** → group_members.role | **mapped** |
| Identity/Is Active   | `player_mapping_queue.source_is_active`; `players.is_active`; `group_members.is_active` | Boolean → 1/0 | ingest → queue; **sync-glide-members** → players and group_members | **mapped** |
| Identity/Photo        | `player_mapping_queue.source_photo_url`; optional `players.photo_url` on resolve | None | ingest → queue; **sync-glide-members** → players.photo_url | **mapped** |
| Group/ID             | `group_members.group_id` | Glide group row ID → groups.id (must exist; run sync-structure first) | **sync-glide-members** → one group_members row per (canonical player, group_id) | **mapped** |

*Summary: All profile fields and the UserProfile ↔ Group relationship are mapped. **Glide v1 username (Identity/Username)** is preserved: it lands in **players.display_name** (sync-glide-members) and in **source_player_name** (round ingest); v2 standings use display_name so names match v1. **sync-glide-members** creates/updates players (merged by email) and group_members (one per profile row); same person in multiple groups → one player, multiple group_members. See [GLIDE_MEMBERSHIP_SYNC_DESIGN.md](./GLIDE_MEMBERSHIP_SYNC_DESIGN.md).*

---

### 2.4 Seasons (v1)

| v1 field name   | v2 field / destination | Transform | Import method | Status |
|-----------------|------------------------|-----------|---------------|--------|
| 🔒 Row ID       | `seasons.id`           | Use as primary key | sync-glide-structure | **mapped** |
| Season/Start Date | `seasons.start_date`  | ISO date (YYYY-MM-DD) | sync-glide-structure | **mapped** |
| Season/End Date | `seasons.end_date`    | ISO date  | sync-glide-structure | **mapped** |
| Group/ID        | `seasons.group_id`     | Glide group row ID → groups.id | sync-glide-structure | **mapped** |

*v2 adds: `created_at`, `updated_at`.*

---

### 2.5 Rounds (v1)

| v1 field name   | v2 field / destination | Transform | Import method | Status |
|-----------------|------------------------|-----------|---------------|--------|
| 🔒 Row ID       | `league_rounds.external_event_id` (with source_app=glide) | Idempotency key | ingest body | **mapped** |
| Round/Date      | `league_rounds.round_date` | YYYY-MM-DD | ingest body | **mapped** |
| Round/Submitted At | `league_rounds.submitted_at` | ISO string → timestamptz | ingest body (optional) | **mapped** |
| Scores/Override | `league_rounds.scores_override` | Boolean → 0/1 | ingest body | **mapped** |
| Group/ID        | `league_rounds.group_id` | User supplies --group-id (Glide group row ID after sync) | convert args + ingest body | **mapped** |

*v2 adds: id (UUID), user_id, season_id, source_app, processing_status, unresolved_player_count, attribution_status, created_at, updated_at. league_rounds.id is v2-generated.*

---

### 2.6 Scores (v1)

| v1 field name   | v2 field / destination | Transform | Import method | Status |
|-----------------|------------------------|-----------|---------------|--------|
| 🔒 Row ID       | —                      | Not stored in v2 (v2 uses own UUID per league_scores row) | — | **intentionally dropped** |
| Round/ID        | Groups score rows; `league_scores.league_round_id` (v2 round UUID) | Glide round row → v2 league_round_id after round insert | ingest (one round = one league_round + N league_scores) | **mapped** |
| Player/ID       | `league_scores.player_id` (resolved) or queue entry | Glide player ref → player_mappings lookup or queue | ingest resolution + insert | **mapped** |
| Score/Value     | `league_scores.score_value` | Numeric   | ingest body scores[].score_value | **mapped** |
| Score/Score Override | `league_scores.score_override` | Numeric; effective = override ?? value | ingest body scores[].score_override | **mapped** |

*v2 adds: id, override_actor, override_reason, override_at, result_type, money_delta, created_at, updated_at.*

---

### 2.7 Payout (v1)

*Glide Payout sheet: columns present in the reference converter are 🔒 Row ID and Index. The live Glide ODS may contain additional columns (e.g. player, amount, date, status); these are not used in the Windex import.*

| v1 field name | v2 field / destination | Transform | Import method | Status |
|----------------|------------------------|-----------|---------------|--------|
| 🔒 Row ID      | —                      | —         | No import     | **intentionally dropped** |
| Index          | —                      | —         | No import     | **intentionally dropped** |
| (any other columns in ODS) | — | — | No import | **intentionally dropped** |

*v2 does not store payout rows. v2 uses `league_scores.money_delta` (computed from points and `groups.dollars_per_point`) and generates payment requests on demand via `generate-payment-requests`; no historical payout ledger.*

---

## 3. Functional parity summary

### 3.1 What v1 functions are fully preserved in v2

- **Structure:** Sections, groups, seasons — create and name; sync from Glide via sync-structure.
- **Rounds and scores:** Record round date, submission time, per-player points, and round-level scores-override flag; idempotent re-import by external_event_id.
- **Standings:** Season standings (rounds played, total points) derived from league_rounds + league_scores; effective points = COALESCE(score_override, score_value).
- **Identity resolution:** Source identity (Glide player ref + name) → queue when unresolved; resolution to canonical player_id and reuse on future ingest.
- **Profile metadata:** Email, Venmo handle, photo, role, is_active preserved in queue and (where used) on players.

### 3.2 What v1 functions are preserved but implemented differently

- **Membership:** v1: UserProfiles rows with Group/ID (one profile per group). v2: explicit `group_members` (group_id, player_id, role, is_active). **sync-glide-members** creates/updates group_members from UserProfiles (idempotent; supports same player in multiple groups).
- **Payouts / money:** v1: Payout sheet (rows; semantics in Glide may vary). v2: no payout table; `money_delta` on each league_score computed from points and `groups.dollars_per_point`; payment requests generated on demand and not stored.
- **Player model:** v1: one UserProfile per (player, group). v2: one canonical `players` row per (id, user_id); same player can belong to multiple groups via multiple `group_members` rows.

### 3.3 What v1 functions are not yet represented (out of scope for v2)

- **Stored payout history:** v1 may track payout rows; v2 has no table for historical payout records (intentionally out of scope).
- **Payment completion tracking:** v2 does not record whether a payment was made or settled (intentionally out of scope).

### 3.4 Membership parity (implemented)

**Membership sync from Glide** is implemented: **sync-glide-members.mjs** reads UserProfiles from the ODS and creates/updates `players` (one per person, merged by email when present) and `group_members` (one row per UserProfile row; same player in multiple groups yields multiple group_members). Also upserts `player_mappings` so round ingest resolves Glide Row ID to the same canonical player. Idempotent; supports v2 many-to-many. **Glide v1 username (Identity/Username)** is preserved: it lands in **players.display_name** (used by v2 standings) and in **source_player_name** (round ingest). See [GLIDE_MEMBERSHIP_SYNC_DESIGN.md](./GLIDE_MEMBERSHIP_SYNC_DESIGN.md).

---

## 4. Special attention areas

### 4.1 Payouts

- **v1:** Payout sheet (at least Row ID, Index; possibly more columns).
- **v2:** No payout table. `league_scores.money_delta` + `groups.dollars_per_point`; compute-money-deltas writes money_delta; generate-payment-requests returns payer→payee list (not stored).
- **Gap:** No migration of v1 payout rows; no stored payout history in v2. Acceptable if v2's model (compute from points, generate requests on demand) replaces v1's.

### 4.2 Settlements

- **v1:** Semantics in Glide unknown (may be implied by Payout or separate).
- **v2:** "Settlement" = money_delta computed and payment requests generated; no "settlement" table; no tracking of payment completion.

### 4.3 Venmo / payment-related data

- **v1:** Identity/Venmo Handle on UserProfiles.
- **v2:** Stored as `player_mapping_queue.source_venmo_handle` and optionally `players.venmo_handle`; used for display and for future Venmo integration. generate-payment-requests returns requests (payer, payee, amount) but does not store Venmo transaction IDs or completion.

### 4.4 Profile / admin metadata

- **v1:** Name, username, email, Venmo, role, is_active, photo, Group/ID.
- **v2:** All have a place: queue (source_*), players (email, venmo_handle, photo_url), and group_members (role, is_active) via **sync-glide-members**.

### 4.5 Group / season / section IDs

- **Stable migration:** sync-glide-structure uses Glide Row IDs as v2 primary keys (sections.id, groups.id, seasons.id). So one-to-one: same ID in Glide and in v2. Round import uses `--group-id` and `--season-id` = those same IDs.
- **external_event_id:** Glide Round Row ID stored on league_rounds for idempotency; v2 league_rounds.id is a new UUID.

### 4.6 Glide-specific row references

- **Round/ID, Player/ID, Group/ID, Section/ID, etc.:** All are Glide row IDs. Where v2 reuses them (sections, groups, seasons), same ID. Where v2 generates new IDs (league_rounds.id, league_scores.id), Glide round row ID is kept in external_event_id; Glide player ID is source_player_ref and (after resolve) maps to canonical player_id. No loss of traceability.

---

## 5. Final conclusion

**v2 is functionally equivalent to v1 for all in-scope areas.** Membership sync is implemented (section 3.4). The canonical Glide import workflow is: **(1) glide:sync-structure**, **(2) glide:sync-members**, **(3) glide:convert**, **(4) glide:import**.

**Glide v1 username (Identity/Username)** is preserved: it lands in **players.display_name** (sync-glide-members; used by v2 standings) and in **source_player_name** (round ingest). v2 standings use display_name so names match v1.

**Intentional out-of-scope exclusions (not migrated):**

1. **Payout history** — v1 Payout sheet is not imported; v2 has no payout table and no stored payout history (only computed money_delta and on-demand payment requests).
2. **Payment/settlement completion** — v2 does not track whether payments were made or rounds "settled."

All other v1 data (sections, groups, seasons, UserProfiles → players + group_members, rounds, scores) has a defined landing place and is migrated via the sync/convert/import pipeline.
