# Settlement Calculation Flow — Design (No Full Tracking Yet)

Defines how **money_delta** is computed and stored. Standings remain points-only; no settlements table in this step.

---

## 1. Write-path options

| Option | Description | Pros | Cons |
|--------|-------------|------|------|
| **Ingest-time** | Compute money_delta when inserting league_scores in ingest-event-results. | Single write path. | Couples settlement rules to every ingest; idempotent 200 returns without re-writing scores (no recompute); requires payout config at ingest; formula changes need backfill. |
| **Post-ingest calculation** | Separate function/job: given a round, read scores + config, compute money_delta, UPDATE league_scores for that round. | Decouples settlement from ingest; ingest stays points-only; can run when rules exist or when user requests “settle this round”; re-runnable if formula changes. | Two write paths (ingest writes points; this writes money_delta). |
| **Manual/admin** | Admin sets money_delta per row or bulk. | Flexible. | No defined formula; doesn’t scale; error-prone. |

---

## 2. Recommended approach: post-ingest calculation

**Recommendation: post-ingest calculation function.**

- **Standings and ingest stay points-only.** Ingest does not read or write money_delta.
- **Settlement is optional and on-demand.** money_delta is filled when someone runs “compute for this round” (e.g. before Venmo export).
- **Formula and config can evolve.** Group/season config (e.g. dollars_per_point) can be added later; the function reads it and the round’s effective points, computes deltas, updates only league_scores.money_delta for that round.
- **Idempotent.** Re-running for the same round overwrites money_delta for that round’s rows; no new rows; safe to retry.
- **No settlements table required.** We only update existing league_scores rows. A settlements table can be added later if we need to track “this round was settled at X” or per-player settlement state.

---

## 3. Minimal settlement-calculation contract

**Scope:** Round-scoped. One round (event) at a time.

**Required inputs**

- **league_round_id** (or round_id) — the event whose league_scores rows will get money_delta.

**Rows read**

- **league_rounds** — one row by id → get group_id, season_id (for future config).
- **league_scores** — all rows where league_round_id = input → get player_id, effective points per row (COALESCE(score_override, score_value)).
- **Optional (future):** group or season config (e.g. dollars_per_point, cap). For minimal step, formula can be hardcoded or assume “zero-sum from points” with a constant scale.

**Rows updated**

- **league_scores** — only rows where league_round_id = input. Set **money_delta** for each row. No inserts; no deletes. No change to score_value, score_override, or any points column.

**Idempotency**

- Re-running for the same league_round_id is idempotent: recompute from current effective points (and config) and overwrite money_delta for that round’s scores. No unique key on money_delta; overwrite is the intended behavior.

**Season-scoped**

- Not in this step. “Settle season” = multiple calls (one per round) or a separate batch design later.

---

## 4. API / function shape

**Name:** `compute-money-deltas` (or `calculate-round-settlement`).

**Shape:** One function, round-scoped.

- **POST** `/compute-money-deltas`  
  **Body:** `{ "league_round_id": "<uuid>" }`  
  **Auth:** Bearer JWT. Caller must be allowed to read/update that round (RLS: league_rounds.user_id = auth.uid()).

**Behavior (contract only):**

1. Resolve round by league_round_id; 404 if not found or no access.
2. Read league_scores for that round (effective points per player).
3. Compute money_delta per row from effective points (formula TBD; e.g. zero-sum, or from future group config).
4. UPDATE each league_scores row for that round with the computed money_delta.
5. Return 200 and a summary (e.g. round_id, number of rows updated, or list of player_id + money_delta).

**Response (minimal):**

- **200:** Either:
  - No payout config: `{ "league_round_id": "...", "computed": false, "reason": "no_payout_config", "message": "..." }`. No rows updated; money_delta left NULL (distinguishes “not computed yet” from “computed to zero”).
  - Computed: `{ "league_round_id": "...", "computed": true, "updated": N }` (N = count of league_scores updated).
- **400:** Invalid or missing league_round_id.
- **404:** Round not found or access denied.
- **500:** Update failed.

No settlements table; no `settled_at`; no new tables.

---

## 5. Venmo insert / export — data source (no implementation)

**Source of truth for “who pays whom how much”:** league_scores.money_delta.

**Conceptual flow:**

1. **Input:** One or more league_round_ids (e.g. “export this round” or “export these rounds”).
2. **Read:** league_scores for those rounds where money_delta IS NOT NULL (and optionally <> 0). Join to league_rounds for round_date/group if needed; join to player identifiers if stored elsewhere.
3. **Output:** Format rows for Venmo insert (e.g. payer, payee, amount, memo). Amount and direction come from money_delta (e.g. positive = receives, negative = pays); aggregation (e.g. net per player across multiple rounds) is an export-layer choice.
4. **No write back.** Export does not set settled_at or clear money_delta; that’s for a future settlement-tracking step if needed.

So: Venmo export **reads** league_scores (and related tables) and uses **money_delta** as the monetary outcome per result; it does not change the DB in this design.

---

## 6. Schema additions for this step

**None required.** money_delta already exists on league_scores. No new tables, no new columns for the *calculation* contract.

**Optional (later):** If the formula is group- or season-specific (e.g. dollars_per_point, cap), add columns to **groups** or **seasons** when you implement the formula. The function would then read those and use them in the calculation. Not required to define the API contract.

---

## 7. Risks and edge cases

| Risk / case | Mitigation |
|-------------|------------|
| Round has 0 or 1 score | Function returns success; no or one row updated; formula must define behavior (e.g. all zeros, or no-op). |
| Re-run after score override | Recompute uses current effective points (COALESCE(score_override, score_value)); money_delta overwritten; correct. |
| Round from another user | RLS: only round owner can read/update; 404 if no access. |
| Concurrent run for same round | Last write wins; idempotent. Optionally use a lock or “version” later if needed. |
| Formula not yet defined | Do not write placeholder zeros. Leave money_delta NULL; return 200 with computed: false, reason: "no_payout_config". Enables real payout once group/season config (e.g. dollars_per_point) exists. |

---

## 8. Summary

- **Recommended write model:** Post-ingest calculation function; ingest does not write money_delta.
- **Minimal API:** POST `/compute-money-deltas` with `{ "league_round_id": "..." }`; round-scoped; reads round + scores (and optional config); updates only league_scores.money_delta for that round; idempotent.
- **Schema:** No new tables or columns for this step.
- **Venmo:** Export reads league_scores.money_delta (and related data); no DB writes in export.
- **Standings:** Unchanged; remain points-only.

---

## 9. Client-side payout modes (Expo app)

The Expo Round Detail screen computes payouts client-side from `score_value` and `game_points`:

### Quick Payout (minimized transactions)
Fewest possible payments: sort players by net position, match biggest loser with biggest winner first, work inward. Same algorithm as `generate-payment-requests` endpoint.

### Full Payout (every loser pays every winner)
Each player pays every player who scored higher the difference in raw game points:
`payment = (game_points_higher - game_points_lower) × dollars_per_point`

Requires `game_points` in `league_scores`. For legacy rounds without `game_points`, falls back to proportional splitting of `score_value`.

### Venmo deep links
Each payment row includes a Venmo button that opens:
`https://venmo.com/{payee_venmo_handle}?txn=pay&amount={amount}&note={group_name}%20Golf%20-%20{round_date}`

`venmo_handle` from `players.venmo_handle`. Button hidden if player has no handle.
