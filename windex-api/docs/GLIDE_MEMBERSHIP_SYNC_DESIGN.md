# Glide → v2 membership sync design

Minimum safe design to sync v1 UserProfiles into v2 **players** and **group_members**, preserving v2 many-to-many (one player, multiple groups).

---

## 1. Conceptual mapping

| v1 | v2 |
|----|-----|
| Section | Section |
| Group (league) | Group |
| Season | Season |
| UserProfile row (identity + one group) | One **player** (canonical) + one **group_members** row per (player, group) |
| Same person in multiple groups (multiple UserProfile rows, same email) | One **players** row; multiple **group_members** rows (one per group) |

---

## 2. Glide UserProfiles → v2 mapping

### 2.1 Player identity

- **Glide field that identifies the profile row:** `🔒 Row ID` (Glide’s stable id for that row). In Scores, `Player/ID` references this same ID.
- **Stable “person” across groups:** Use **email** when present. All UserProfile rows with the same normalized email (trim, lowercase) are treated as the same person → one v2 **player** and multiple **group_members** (one per Group/ID).
- **When email is missing:** No merge. One v2 player per UserProfile row; `players.id` = that row’s `🔒 Row ID`.

**Canonical player id:** For each “person” (email group or single row):

- If merged by email: use the **first** UserProfile row’s `🔒 Row ID` (in stable order) as the canonical `players.id`. All Glide Row IDs in that email group are mapped to this id via **player_mappings** so round ingest (which sends `source_player_ref` = Glide Player/ID = that Row ID) resolves to the same player.
- If no email: `players.id` = that row’s `🔒 Row ID`.

### 2.2 Group identity

- **Glide field:** `Group/ID` (references Glide Groups row).
- **v2:** `group_members.group_id` = same id (after **sync-glide-structure**, groups exist with Glide Row IDs as `groups.id`). Rows whose `Group/ID` does not exist in v2 are skipped (log warning).

### 2.3 Duplicate prevention

- **players:** Composite PK `(id, user_id)`. Upsert on conflict `(id, user_id)`; update display_name, email, venmo_handle, photo_url, is_active so re-runs refresh from Glide.
- **group_members:** `UNIQUE(group_id, player_id)`. Use deterministic id `gm_<group_id>_<player_id>` (sanitized) so upsert on conflict updates the same row. Prevents duplicate memberships.
- **player_mappings:** `UNIQUE(user_id, source_app, source_player_ref)`. Upsert so each Glide Row ID maps to the chosen canonical_player_id; re-runs stay idempotent.

### 2.4 Same player in multiple groups

- Each UserProfile row = one (person, group) pair. We resolve “person” by email (or Row ID if no email).
- For each row we upsert one **group_members** row: `(group_id = Group/ID, player_id = canonical player_id, role, is_active)`.
- No collapsing: if the same email appears in two rows with different Group/ID, we get two **group_members** rows for the same **player_id**. v2 multi-group behavior is preserved.

---

## 3. Field-level mapping

### 3.1 UserProfiles → players (one row per canonical player)

In v1, **username** is what is shown in Standings and competition views. v2 keeps that parity: **display_name** = username so standings match v1.

| Glide field | v2 column | Transform / note |
|-------------|-----------|-------------------|
| 🔒 Row ID | Used to choose canonical id (first in email group) or as players.id when no email | — |
| Identity/Username | players.display_name | **v1 standings show username;** fallback Name else Row ID if username empty |
| Identity/Name | players.full_name | Real name (profile metadata); not used in standings |
| Identity/Email | players.email | Normalized for merge; stored on player |
| Identity/Venmo Handle | players.venmo_handle | — |
| Identity/Photo | players.photo_url | — |
| Identity/Is Active | players.is_active | true → 1, false → 0 (applies to player row; per-group is in group_members) |

When multiple rows merge by email, first non-empty value wins for display_name (username), full_name (name), venmo_handle, photo_url; is_active = 1 if any row is active.

### 3.2 UserProfiles → group_members (one row per profile row)

| Glide field | v2 column | Transform / note |
|-------------|-----------|-------------------|
| Group/ID | group_members.group_id | Must exist in v2 (run sync-structure first) |
| (resolved) | group_members.player_id | Canonical player id from step above |
| Identity/Role | group_members.role | Default 'member' if empty |
| Identity/Is Active | group_members.is_active | true → 1, false → 0 |

group_members.id = deterministic `gm_<group_id>_<player_id>` (sanitized) for idempotent upsert.

### 3.3 Row ID → canonical player (for round ingest)

| Glide 🔒 Row ID (each UserProfile row) | player_mappings.source_player_ref | player_mappings.canonical_player_id |
|----------------------------------------|-----------------------------------|-------------------------------------|
| Any | That Row ID | The canonical players.id for that person (email group or self) |

So when Scores are ingested with `Player/ID` = Row ID, ingest finds the mapping and uses the same canonical player.

---

## 4. Sync command and order

1. **sync-glide-structure** (sections, groups, seasons) so `groups.id` and section/season exist.
2. **sync-glide-members** (players + group_members + player_mappings from UserProfiles).
3. **glide:convert** + **glide:import** for rounds/scores (source_player_ref will resolve via player_mappings).

Sync is idempotent: re-run overwrites/updates only; no duplicate players or group_members.

---

## 5. Out of scope

- Payout import and payout history.
- Settlement or payment-completion tracking.
- Changes to the core membership model beyond this sync path.
