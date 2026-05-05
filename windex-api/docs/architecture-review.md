# Windex Backend — Architectural Review

Technical summary of the current implementation after domain-rule tests pass. Windex operates as a **points ledger + standings aggregation platform**: atomic point records in `league_scores` are the single source of truth; standings are derived only from those records and are never edited directly. See [POINTS_LEDGER_ARCHITECTURE.md](./POINTS_LEDGER_ARCHITECTURE.md) for the full design.

---

## 1. Schema summary

### Tables and key columns

| Table | PK | Key columns | Foreign keys | Constraints |
|-------|----|-------------|--------------|-------------|
| **sections** | id (TEXT) | user_id, name, created_at, updated_at | user_id → auth.users(id) | — |
| **groups** | id (TEXT) | user_id, name, section_id, admin_player_id, season_start_month, **scoring_mode** | user_id → auth.users(id), section_id → sections(id) | CHECK scoring_mode IN ('points', 'win_loss_override') |
| **group_members** | id (TEXT) | group_id, player_id, role, is_active, joined_at | group_id → groups(id) | UNIQUE(group_id, player_id) |
| **seasons** | id (TEXT) | group_id, start_date, end_date, created_at, updated_at | group_id → groups(id) | — |
| **league_rounds** (events) | id (TEXT) | user_id, group_id, season_id, round_date, submitted_at, scores_override, **source_app**, **external_event_id** | user_id → auth.users(id), group_id → groups(id), season_id → seasons(id) | UNIQUE INDEX (group_id, source_app, external_event_id) WHERE both non-null |
| **league_scores** (points ledger) | id (TEXT) | league_round_id, player_id, **score_value**, **score_override**, **result_type**, **override_actor**, **override_reason**, **override_at**, **money_delta** | league_round_id → league_rounds(id) | UNIQUE(league_round_id, player_id), CHECK result_type IN ('win','loss','tie') OR NULL. One atomic point record per player per round; effective points = COALESCE(score_override, score_value). |

**money_delta:** On league_scores, nullable DOUBLE PRECISION. For settlement requests / Venmo insert generation only. Not used in season_standings. Left null by ingest until settlement rules exist.

**Settlements:** No settlements table. No settled_at on league_rounds.

**RLS:** All tables have RLS enabled. Policies enforce ownership (user_id) or group ownership for members/seasons; league_rounds/league_scores by user_id or via league_round ownership.

---

## 2. Standings implementation (derived from ledger only)

Standings are **never** stored in a mutable table. They are computed on read from the points ledger (`league_scores`) joined with `league_rounds`. No direct editing of standings; corrections are made by updating atomic point rows in `league_scores` (e.g. via round edit/override).

### Aggregation

**Location:** PostgreSQL view `season_standings` (defined in `001_core_schema.sql`). Read-only.

**Exact SQL:**

```sql
CREATE OR REPLACE VIEW season_standings AS
SELECT
  lr.season_id,
  lr.group_id,
  ls.player_id,
  COUNT(DISTINCT lr.id) AS rounds_played,
  COALESCE(SUM(COALESCE(ls.score_override, ls.score_value)), 0)::DOUBLE PRECISION AS total_points
FROM league_rounds lr
JOIN league_scores ls ON ls.league_round_id = lr.id
WHERE lr.season_id IS NOT NULL
GROUP BY lr.season_id, lr.group_id, ls.player_id;
```

**Fields calculated:**

- **season_id**, **group_id**, **player_id** — grouping keys.
- **rounds_played** — COUNT(DISTINCT lr.id) (events in that season for that player).
- **total_points** — SUM of effective score per row; effective = COALESCE(score_override, score_value). No net_winnings or money fields.

**Ranking:** Not in the view. The **get-standings** Edge Function queries the view and orders by `total_points` descending (`.order("total_points", { ascending: false })`).

**Dependency:** Standings depend **only** on event results: `league_rounds` + `league_scores`. Only effective **points** are used (COALESCE(score_override, score_value)). No money_delta, net_winnings, or settlement state in the view. Overrides are incorporated via that COALESCE.

---

## 3. Ingest contract

**Endpoint:** POST `/ingest-event-results`  
**Auth:** Bearer JWT required. Group/round/scores access enforced via RLS and ownership checks.

**Note:** `scoring_mode` is **not** in the request body; it is read from the **group** row. The payload below uses `scoring_mode` in the example for clarity only.

### A) Points mode (group.scoring_mode = 'points')

**Example payload:**

```json
{
  "group_id": "group-seed-001",
  "season_id": "season-seed-001",
  "round_date": "2025-06-15",
  "source_app": "my-app",
  "external_event_id": "event-123",
  "scores": [
    { "player_id": "player-1", "score_value": 2 },
    { "player_id": "player-2", "score_value": -1 }
  ]
}
```

Optional override (actor/reason required):

```json
"scores": [
  { "player_id": "player-1", "score_value": 0, "score_override": 3, "override_actor": "admin@test", "override_reason": "Correction" }
]
```

- **score_value** = points; must be in **[-10, 10]** and **not** in stroke-like range [20, 130] (rejected as raw_stroke_score_rejected or points_out_of_range).

### B) win_loss_override mode (group.scoring_mode = 'win_loss_override')

**Example payload:**

```json
{
  "group_id": "group-seed-002",
  "season_id": "season-seed-002",
  "round_date": "2025-06-15",
  "scores": [
    { "player_id": "player-1", "result_type": "win" },
    { "player_id": "player-2", "result_type": "loss" }
  ]
}
```

- **result_type** required per score: `"win"` | `"loss"` | `"tie"`.  
- API accepts this input and stores equivalent points (win=1, loss=0, tie=0.5) in **score_value**; **result_type** stored on league_scores. Outcome is determined by the source or admin; Windex does not compute match-play or other format logic.

### Validation steps (order in code)

1. **Body:** group_id, round_date, non-empty scores array required; else 400.
2. **Auth:** Bearer token → getUser(token); else 401.
3. **Group:** Fetch group by group_id; must exist and be readable (RLS); else 404.
4. **Season–group invariant:** If season_id provided, fetch season and require season.group_id === group_id; else 400, code season_group_mismatch.
5. **Membership:** All score player_ids must exist in group_members for group_id with is_active = 1; else 400, invalid_player_ids.
6. **Scoring mode (points):** Each effective value (score_override ?? score_value) must be numeric; not in [20, 130]; in [-10, 10]; if score_override set, override_actor and override_reason required.
7. **Scoring mode (win_loss_override):** Each score must have result_type in (win, loss, tie); if score_override set, override_actor and override_reason required.
8. **Idempotency:** If source_app and external_event_id both non-empty, SELECT existing league_round by (group_id, source_app, external_event_id); if found, return 200 and existing id.
9. **Insert:** One league_rounds row, then N league_scores rows. On unique violation 23505 for league_rounds, re-fetch existing and return 200.

### Idempotency logic

- Key: (group_id, source_app, external_event_id). Both source_app and external_event_id must be non-empty to be idempotent.
- Before insert: SELECT existing; if found → 200 + existing league_round_id.
- On insert: If 23505, SELECT existing and return 200 + that id (no duplicate round or scores).

---

## 4. Override implementation

**Schema fields (league_scores):**

- **score_override** (DOUBLE PRECISION) — override value; when non-null, used instead of score_value in standings.
- **override_actor** (TEXT) — required when score_override is set.
- **override_reason** (TEXT) — required when score_override is set.
- **override_at** (TIMESTAMPTZ) — set by server to now when override is stored.

**Effective result:** COALESCE(score_override, score_value). Used in application logic for validation (points range) and in the view for totals.

**Standings:** The view uses COALESCE(ls.score_override, ls.score_value) per row, then SUM for total_points. So standings incorporate overrides automatically.

**Validation:** When any score has score_override set, override_actor and override_reason are required in the same request; else 400, code override_metadata_required. override_at is server-set.

---

## 5. Domain rule enforcement

| Rule | Database | Service / Edge Function | Integration test | Domain test |
|------|----------|-------------------------|------------------|-------------|
| Points not raw scores; range -10..10 | — | ingest: points mode checks value, rejects [20,130] and out-of-range | — | Reject 72/75; reject 15; valid points 2/-1 |
| Season belongs to group; event’s season matches group | FK season_id → seasons, seasons.group_id → groups | ingest: if season_id, verify season.group_id === group_id | — | Mismatch season_id → 400 |
| Active group membership | group_members.is_active | ingest: filter group_members by group_id, is_active=1; reject if any score player_id not in set | Invalid player → 400 invalid_player_ids | Non-member → 400 invalid_player_ids |
| Idempotency by external_event_id | UNIQUE (group_id, source_app, external_event_id) | ingest: lookup before insert; on 23505 re-fetch and 200 | Same body twice → 200, same id | First 201, second 200, no duplicate row |
| Override: actor, reason, timestamp | override_actor, override_reason, override_at columns | ingest: require actor+reason when score_override set; set override_at | — | Override stored; standings use override; reject override without metadata |
| Scoring modes points / win_loss_override | groups.scoring_mode CHECK | ingest: read group; points vs result_type validation; win_loss stores equivalent points from result_type | — | win_loss accepts result_type and stores equivalent points; result_type stored |
| Standings from event_results only | View on league_rounds + league_scores only | get-standings reads view | Standings 2 and -1 | Standings derive from events, not settlements |
| Multi-group: one result per group | league_rounds.group_id | Ingest targets single group_id | — | Submit to A and B → one round per group; standings per group |

---

## 6. Remaining domain gaps (for next milestone)

- **Payout / money_delta:** Not implemented. No column or table for monetary deltas or payouts per event or per player.
- **Settlement tracking:** No settlements table. No concept of “settlement” or “settled at” for rounds or players.
- **Group-configurable scoring rules:** Points range (-10..10) and stroke-like range (20..130) are hardcoded in the ingest function. win_loss input mapping (result_type → 1/0/0.5) is hardcoded; this is input normalization only—Windex does not compute golf format (e.g. match-play) logic. No group-level or season-level config for these.
- **Primary standings metric:** Standings are always total_points (sum of effective score), ordered descending. No configurable “primary metric” (e.g. net_winnings vs total_points).
- **Ambiguous multi-group ingest:** Not applicable. Each ingest has a single group_id; no ambiguity. Multi-group is “same player in multiple groups, separate events per group.”

---

## 7. Next migration recommendation (minimal for payout logic)

**Goal:** Support payout logic without redesigning existing event/standings flow.

**Minimal schema change:**

- Add a **per-event-result** monetary delta on **league_scores**, e.g.:
  - **money_delta** DOUBLE PRECISION (or INTEGER cents) NULL — payout for that player for that round (positive = won, negative = lost).
- Optionally add **league_rounds.settled_at** TIMESTAMPTZ NULL to mark when a round’s payouts are final (if you need settlement tracking later).

**Rationale:**

- Standings remain driven by event results (league_rounds + league_scores). A separate **season_standings** view or a new view can add SUM(money_delta) AS total_winnings if needed, without changing the existing total_points view.
- Payout logic can live in an Edge Function or batch job that computes money_delta from scores (and optional group rules) and updates league_scores, or a separate **settlement** table keyed by (league_round_id, player_id) with money_delta. The minimal path is one new nullable column on league_scores so that existing RLS and uniqueness are unchanged.

**Implemented:** Migration `004_money_delta.sql` adds `money_delta DOUBLE PRECISION NULL` to league_scores only. No settled_at on league_rounds; no settlements table. Standings view unchanged.

---

*Summary: The backend enforces the listed domain rules via schema constraints and the ingest/get-standings Edge Functions. Standings are view-only from event results with overrides. No settlements or payouts yet. Minimal next step for payout logic is adding money_delta (and optionally settled_at) as above.*
