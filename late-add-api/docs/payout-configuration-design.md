# Payout Configuration Model — Windex

Minimal design to enable real **money_delta** computation in `compute-money-deltas` without changing standings or adding a settlements table.

---

## 1. Where payout config should live

**Recommendation: groups only (for the first model).**

| Location       | Pros | Cons |
|----------------|------|------|
| **groups**     | Every round has `group_id`; one place to read; consistent with `scoring_mode`; no nullable resolution. | Cannot vary by season or round without adding more later. |
| **seasons**    | Could support different $/point per season. | `league_rounds.season_id` is nullable; rounds without a season would need fallback (e.g. group). Adds resolution logic. |
| **league_rounds** | Per-round override (e.g. “this round $2/point”). | More columns and branching; overkill for minimal first step. |

**Conclusion:** Put the first payout config on **groups**. The function already loads the round then `group_id`; one extra column on `groups` is the smallest change. Season- or round-level overrides can be added later if needed.

---

## 2. Minimal first payout model

**Recommendation: dollars_per_point (single scalar on groups).**

| Option | Description | Fit |
|--------|-------------|-----|
| **dollars_per_point** | One number: $ per point. money_delta = (effective_points − round_mean) × dollars_per_point. | Works for both `points` and `win_loss_override` (both store effective points). Single column; natural zero-sum; ties/zeros are just same deviation from mean. |
| Fixed win/loss/tie | e.g. win=+$5, loss=−$5, tie=$0. | Would need separate formula for points mode; more columns; doesn’t scale to arbitrary point ranges. |
| Per-round multiplier | e.g. league_rounds.multiplier. | Still requires a base (dollars_per_point or fixed). Adds complexity; defer. |

**Conclusion:** Use **dollars_per_point** on groups. It fits the existing “effective points per result” model, keeps config to one number, and yields a simple zero-sum formula.

---

## 3. Exact fields for the first payout config migration

**Single column on `groups`:**

| Column | Type | Nullable | Constraint | Meaning |
|--------|------|----------|------------|---------|
| **dollars_per_point** | DOUBLE PRECISION | YES (NULL) | CHECK (dollars_per_point IS NULL OR dollars_per_point >= 0) | Dollars per point of deviation from the round mean. NULL = payout not configured (function returns `computed: false`, does not write). 0 = compute and write zero for all. Positive = rate in $ per point. |

**Migration (`005_payout_config.sql`):**

```sql
ALTER TABLE groups ADD COLUMN IF NOT EXISTS dollars_per_point DOUBLE PRECISION NULL;
ALTER TABLE groups ADD CONSTRAINT groups_dollars_per_point_check
  CHECK (dollars_per_point IS NULL OR dollars_per_point >= 0);
```

No new tables. No changes to seasons or league_rounds for this step. **Standings remain points-only**; money_delta is for settlement/Venmo only and is not used in the standings view.

---

## 4. How compute-money-deltas uses the config

1. Load **league_rounds** row by `league_round_id`; get `group_id`.
2. Load **groups.dollars_per_point** for that `group_id`. If NULL → return 200 with `computed: false`, `reason: "no_payout_config"`; do not update any rows.
3. Load **league_scores** for the round (ordered by `id` ascending for deterministic residual). Effective points = `COALESCE(score_override, score_value)`.
4. **If 0 scores:** return 200 with `computed: true`, `updated: 0`; no updates.
5. **Otherwise:**  
   - `round_mean = sum(effective_points) / n`  
   - Raw delta per row: `(effective_points − round_mean) * dollars_per_point`  
   - Round each value to **2 decimal places** (e.g. `Math.round(v * 100) / 100`).  
   - **Zero-sum after rounding:** sum of rounded values may not be exactly 0 due to rounding. Compute residual = 0 − sum(rounded). Apply the residual to **exactly one row** so the round sums to zero. **Deterministic rule:** the row that receives the residual is the one with the **smallest `league_scores.id`** (i.e. first row when ordered by `id` ascending).  
   - UPDATE each row: `SET money_delta = <final value>` for that round only.  
6. Return 200 with `computed: true`, `updated: N`.

**Example formula (numeric):**  
- Round: 4 players, effective points 3, 1, −2, −2. Mean = 0.  
- dollars_per_point = 2.  
- Raw deltas: (3−0)×2 = 6, (1−0)×2 = 2, (−2−0)×2 = −4, (−2−0)×2 = −4. Sum = 0 (zero-sum). After rounding to 2 decimals, sum may be e.g. −0.01; residual +0.01 is added to the first row (by id).

---

## 5. Zero-sum guarantee and rounding

- **Zero-sum:** The formula (effective_points − round_mean) × dollars_per_point is mathematically zero-sum. After rounding each value to 2 decimal places, the sum of rounded values may not be exactly 0. A **residual adjustment** is applied so the stored money_delta values sum to 0: residual = 0 − sum(rounded); this residual is **added to the row with the smallest `league_scores.id`** (first row when scores are ordered by `id` ascending). That row’s final money_delta is rounded_value + residual. All other rows keep their rounded value. Thus the round remains zero-sum after rounding.
- **Standings:** Unchanged. Standings remain **points-only** (rounds_played, total_points). money_delta is not used in the standings view.

---

## 6. Edge-case summary (explicit behavior)

| Case | Behavior |
|------|----------|
| **0 scores in round** | Return 200 with `computed: true`, `updated: 0`. No rows updated. |
| **1 score in round** | round_mean = that score; deviation 0; money_delta = 0 for that row. Updated: 1. |
| **All same effective points** | round_mean = that value; all deviations 0; all money_delta = 0. Updated: N. |
| **Rerun after override** | Recompute from current effective points (COALESCE(score_override, score_value)); overwrite money_delta for that round only. Idempotent; new deltas reflect the override. |
| `groups.dollars_per_point` IS NULL | No config; return `computed: false`; do not write; leave money_delta NULL. |
| `dollars_per_point` = 0 | Config present; compute; write 0 for all; return `computed: true`, `updated: N`. |

---

## 7. What we are not doing (minimal scope)

- No standings redesign; standings remain points-only.
- No settlements table; no `settled_at` or settlement state.
- No Venmo export implementation.
- No season-level or round-level config in this step (groups only).
- No fixed win/loss/tie dollar amounts; single rate only.

---

## 8. Implementation status

- **Migration 005** adds `groups.dollars_per_point` with `CHECK (dollars_per_point IS NULL OR dollars_per_point >= 0)`.
- **compute-money-deltas** reads the round’s `group_id`, loads `groups.dollars_per_point`; if NULL returns `computed: false`; otherwise computes zero-sum deltas (rounded to 2 decimals, residual on row with smallest `league_scores.id`), UPDATEs only `league_scores.money_delta` for that round, returns `computed: true`, `updated: N`.
- Standings and ingest are unchanged; no settlements table.
