# Glide ODS → Windex field mapping

All Glide export fields now have a place in Windex. **Glide v1 username (Identity/Username) is preserved:** it lands in **players.display_name** (sync-members) and in **source_player_name** (round ingest). The canonical import workflow is: **(1) glide:sync-structure**, **(2) glide:sync-members**, **(3) glide:convert**, **(4) glide:import**.

---

## Round ingest (convert + import)

| Glide sheet   | Glide column        | Windex target |
|---------------|---------------------|--------------------|
| Rounds        | 🔒 Row ID           | `external_event_id` (idempotency) |
| Rounds        | Round/Date          | `round_date` |
| Rounds        | Round/Submitted At  | `submitted_at` (ingest body; stored on `league_rounds.submitted_at`) |
| Rounds        | Scores/Override     | `scores_override` |
| Rounds        | Group/ID            | You pass `--group-id` (use Glide Group Row ID after sync-structure) |
| Scores        | Round/ID            | Groups scores per round |
| Scores        | Player/ID           | `source_player_ref` |
| Scores        | Score/Value         | `score_value` (points) |
| Scores        | Score/Score Override| Effective points when set; else Score/Value |
| UserProfiles  | 🔒 Row ID           | Same as Player/ID → `source_player_ref` |
| UserProfiles  | Identity/Username | `source_player_name` (and `players.display_name` via sync-members). **v1 standings show username;** v2 standings use display_name so they match. |
| UserProfiles  | Identity/Name     | `players.full_name` (profile only; not used in standings) |
| UserProfiles  | Identity/Email      | `source_email` → stored in `player_mapping_queue.source_email` when unresolved |
| UserProfiles  | Identity/Venmo Handle | `source_venmo_handle` → `player_mapping_queue.source_venmo_handle`; optional on `players.venmo_handle` on resolve |
| UserProfiles  | Identity/Role       | `source_role` → `player_mapping_queue.source_role` (can inform `group_members.role` on resolve) |
| UserProfiles  | Identity/Is Active  | `source_is_active` → `player_mapping_queue.source_is_active` |
| UserProfiles  | Identity/Photo     | `source_photo_url` → `player_mapping_queue.source_photo_url`; optional on `players.photo_url` on resolve |
| UserProfiles  | Group/ID            | Used to associate profile with group (converter does not filter by group) |

---

## Structure sync (glide:sync-structure)

Run **first** so sections, groups, and seasons exist with the same IDs as in Glide. Then use those IDs as `--group-id` and `--season-id` when running **glide:convert**.

| Glide sheet   | Glide column        | Windex target |
|---------------|---------------------|--------------------|
| Sections      | 🔒 Row ID           | `sections.id` (used as stable ID for sync) |
| Sections      | Section/Name        | `sections.name` |
| Groups        | 🔒 Row ID           | `groups.id` (use this as `--group-id`) |
| Groups        | Group/Name          | `groups.name` |
| Groups        | Group/Logo          | `groups.logo_url` |
| Groups        | Section/ID          | `groups.section_id` |
| Groups        | Admin/ID            | `groups.admin_player_id` |
| Groups        | Season/Start Month  | `groups.season_start_month` |
| Seasons       | 🔒 Row ID           | `seasons.id` (use this as `--season-id`) |
| Seasons       | Group/ID            | `seasons.group_id` |
| Seasons       | Season/Start Date   | `seasons.start_date` |
| Seasons       | Season/End Date     | `seasons.end_date` |

**Note:** `Group/Created At` from Glide is not stored; Windex uses server `created_at`/`updated_at`. Sync updates `updated_at` on upsert.

---

## Payouts

| Glide sheet   | Note |
|---------------|------|
| Payouts       | No mapping. Windex has `money_delta` and its own payout/settlement logic; Glide payout rows are not imported. |

---

## Membership sync (glide:sync-members)

UserProfiles → v2 **players** and **group_members** (one row per profile row; same person in multiple groups → one player, multiple group_members). Idempotent; run after sync-structure so groups exist.

| Glide (UserProfiles) | v2 destination |
|----------------------|----------------|
| 🔒 Row ID (per row)  | Resolved to canonical `players.id` (merged by email when present); also `player_mappings.source_player_ref` so round ingest resolves. |
| Identity/Username   | `players.display_name` — **v1 standings show username; v2 standings use display_name so names match.** |
| Identity/Name       | `players.full_name` (real name; profile metadata only) |
| Identity/Email       | `players.email` (and merge key for same person across groups) |
| Identity/Venmo Handle, Photo | `players.venmo_handle`, `players.photo_url` |
| Identity/Is Active   | `players.is_active`, `group_members.is_active` |
| Identity/Role         | `group_members.role` |
| Group/ID             | `group_members.group_id` (must exist in v2; run sync-structure first) |

**Standings and UI:** All v2 standings queries and UI (get-standings, events, standings-player-history, players API) use `players.display_name` only. With display_name = v1 username, v2 standings show the same names as v1.

See [GLIDE_MEMBERSHIP_SYNC_DESIGN.md](./GLIDE_MEMBERSHIP_SYNC_DESIGN.md). Command: `npm run glide:sync-members -- path/to/export.ods` (or `--dry-run`).

---

## Recommended workflow for frequent Glide imports

1. **One-time or when structure changes:**  
   `npm run glide:sync-structure -- path/to/export.ods`  
   Creates/updates sections, groups, seasons from the ODS.

2. **One-time or when members change:**  
   `npm run glide:sync-members -- path/to/export.ods`  
   Creates/updates players and group_members from UserProfiles (idempotent; supports multi-group).

3. **Each new export:**  
   `npm run glide:convert -- path/to/export.ods --group-id=<Glide_Group_Row_ID> --season-id=<Glide_Season_Row_ID>`  
   Writes round JSON with all profile and round fields.

4. **Import rounds:**  
   `npm run glide:import`  
   POSTs each round to ingest-event-results (with auth from env). Player/ID in scores resolves via player_mappings created by sync-members.

Unresolved players (if any) go to `player_mapping_queue` with `source_email`, `source_venmo_handle`, `source_photo_url`, `source_is_active`, and `source_role` preserved for admin review.
